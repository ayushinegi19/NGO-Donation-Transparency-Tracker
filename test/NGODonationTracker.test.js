const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Matches the Solidity enums
const Category = { Disaster: 0, Education: 1, Health: 2, Food: 3, Other: 4 };
const CreatorType = { Unverified: 0, Organisation: 1, Individual: 2 };

const eth = (n) => ethers.parseEther(String(n));
const receipt = (text) => ethers.sha256(ethers.toUtf8Bytes(text)); // stands in for the SHA-256 of a PDF
const RECEIPT_1 = receipt("receipt1.pdf contents");
const RECEIPT_2 = receipt("receipt2.pdf contents");
const RECEIPT_URI = "ipfs://bafyexamplecid";

describe("NGODonationTracker", function () {
  let tracker, owner, ngo, donor1, donor2, vendor, stranger;
  let deadline;
  const goal = eth(5);

  beforeEach(async function () {
    [owner, ngo, donor1, donor2, vendor, stranger] = await ethers.getSigners();
    tracker = await ethers.deployContract("NGODonationTracker", [owner.address]);
    deadline = (await time.latest()) + 7 * 24 * 60 * 60; // one week from now

    await tracker
      .connect(ngo)
      .createCause("Flood Relief", "Food and shelter kits", Category.Disaster, goal, deadline);
  });

  // Helper: fund cause 1 up to its goal so spending is allowed
  async function reachGoal() {
    await tracker.connect(donor1).donate(1, { value: eth(3) });
    await tracker.connect(donor2).donate(1, { value: eth(2) });
  }

  function spend(amount, { signer = ngo, to = vendor.address, hash = RECEIPT_1, desc = "Rice bags" } = {}) {
    return tracker.connect(signer).logExpenditure(1, desc, amount, to, hash, RECEIPT_URI);
  }

  describe("Owner and verified creators", function () {
    it("sets the owner passed to the constructor, even if another account deploys", async function () {
      expect(await tracker.owner()).to.equal(owner.address);
      const t = await ethers.deployContract("NGODonationTracker", [owner.address], vendor);
      expect(await t.owner()).to.equal(owner.address);
      await expect(t.connect(vendor).setCreatorType(ngo.address, CreatorType.Organisation)).to.be.revertedWith(
        "Only the owner can do this"
      );
    });

    it("rejects a zero owner", async function () {
      await expect(ethers.deployContract("NGODonationTracker", [ethers.ZeroAddress])).to.be.revertedWith("Invalid owner");
    });

    it("lets the owner verify a creator as an organisation or an individual", async function () {
      await expect(tracker.connect(owner).setCreatorType(ngo.address, CreatorType.Organisation))
        .to.emit(tracker, "CreatorVerified")
        .withArgs(ngo.address, CreatorType.Organisation);
      expect(await tracker.creatorType(ngo.address)).to.equal(CreatorType.Organisation);

      await tracker.connect(owner).setCreatorType(donor1.address, CreatorType.Individual);
      expect(await tracker.creatorType(donor1.address)).to.equal(CreatorType.Individual);

      await tracker.connect(owner).setCreatorType(ngo.address, CreatorType.Unverified);
      expect(await tracker.creatorType(ngo.address)).to.equal(CreatorType.Unverified);
    });

    it("does not let anyone else verify creators", async function () {
      await expect(tracker.connect(ngo).setCreatorType(ngo.address, CreatorType.Organisation)).to.be.revertedWith(
        "Only the owner can do this"
      );
    });

    it("does not let the platform owner create causes", async function () {
      await expect(tracker.connect(owner).createCause("t", "d", 0, goal, deadline)).to.be.revertedWith(
        "The platform owner cannot create causes"
      );
    });
  });

  describe("Cause creation", function () {
    it("stores the cause with the creator as NGO", async function () {
      const cause = await tracker.getCause(1);
      expect(cause.id).to.equal(1);
      expect(cause.ngo).to.equal(ngo.address);
      expect(cause.title).to.equal("Flood Relief");
      expect(cause.category).to.equal(Category.Disaster);
      expect(cause.goal).to.equal(goal);
      expect(cause.deadline).to.equal(deadline);
      expect(cause.totalRaised).to.equal(0);
    });

    it("emits CauseCreated", async function () {
      await expect(tracker.connect(donor1).createCause("School Books", "", Category.Education, goal, deadline))
        .to.emit(tracker, "CauseCreated")
        .withArgs(2, donor1.address, "School Books", Category.Education, goal, deadline);
    });

    it("rejects invalid input", async function () {
      const c = tracker.connect(ngo);
      await expect(c.createCause("", "d", 0, goal, deadline)).to.be.revertedWith("Title is required");
      await expect(c.createCause("t", "d", 0, 0, deadline)).to.be.revertedWith("Goal must be greater than 0");
      await expect(c.createCause("t", "d", 0, goal, 1)).to.be.revertedWith("Deadline must be in the future");
    });
  });

  describe("Donations", function () {
    it("records each donation and tracks per-donor contributions", async function () {
      await tracker.connect(donor1).donate(1, { value: eth(2) });
      await tracker.connect(donor2).donate(1, { value: eth(1) });
      await tracker.connect(donor1).donate(1, { value: eth(0.5) });

      const list = await tracker.getDonations(1);
      expect(list.length).to.equal(3);
      expect(list[0].donor).to.equal(donor1.address);
      expect(list[1].amount).to.equal(eth(1));
      expect(await tracker.contributions(1, donor1.address)).to.equal(eth(2.5));
      expect((await tracker.getCause(1)).totalRaised).to.equal(eth(3.5));
    });

    it("moves the ETH into the contract and emits DonationReceived", async function () {
      const tx = tracker.connect(donor1).donate(1, { value: eth(1) });
      await expect(tx).to.emit(tracker, "DonationReceived").withArgs(1, donor1.address, eth(1));
      await expect(tx).to.changeEtherBalances([donor1, tracker], [-eth(1), eth(1)]);
    });

    it("accepts the donation that crosses the goal, then closes donations", async function () {
      await tracker.connect(donor1).donate(1, { value: eth(4) });
      await tracker.connect(donor2).donate(1, { value: eth(3) }); // 7 ETH raised, goal was 5
      expect((await tracker.getCause(1)).totalRaised).to.equal(eth(7));
      await expect(tracker.connect(donor1).donate(1, { value: eth(1) })).to.be.revertedWith(
        "Goal reached, donations are closed"
      );
    });

    it("rejects zero, unknown cause, and after-deadline donations", async function () {
      await expect(tracker.connect(donor1).donate(1, { value: 0 })).to.be.revertedWith("Donation must be greater than 0");
      await expect(tracker.connect(donor1).donate(99, { value: 1 })).to.be.revertedWith("Cause does not exist");
      await time.increaseTo(deadline + 1);
      await expect(tracker.connect(donor1).donate(1, { value: 1 })).to.be.revertedWith("Cause deadline has passed");
    });
  });

  describe("Expenditures with automatic audit", function () {
    it("pays the recipient immediately and records the expenditure with its receipt", async function () {
      await reachGoal();
      const tx = spend(eth(2));
      await expect(tx)
        .to.emit(tracker, "ExpenditureLogged")
        .withArgs(1, 0, vendor.address, eth(2), "Rice bags", RECEIPT_1);
      await expect(tx).to.changeEtherBalances([tracker, vendor], [-eth(2), eth(2)]);

      const [e] = await tracker.getExpenditures(1);
      expect(e.description).to.equal("Rice bags");
      expect(e.amount).to.equal(eth(2));
      expect(e.recipient).to.equal(vendor.address);
      expect(e.receiptHash).to.equal(RECEIPT_1);
      expect(e.receiptURI).to.equal(RECEIPT_URI);
      expect(await tracker.receiptUsed(RECEIPT_1)).to.equal(true);
      expect((await tracker.getCause(1)).totalSpent).to.equal(eth(2));
    });

    it("only lets the cause's NGO spend", async function () {
      await reachGoal();
      await expect(spend(eth(1), { signer: stranger })).to.be.revertedWith("Only the cause's NGO can do this");
      await expect(spend(eth(1), { signer: donor1 })).to.be.revertedWith("Only the cause's NGO can do this");
      await expect(spend(eth(1), { signer: owner })).to.be.revertedWith("Only the cause's NGO can do this");
    });

    it("blocks spending until the goal is reached", async function () {
      await tracker.connect(donor1).donate(1, { value: eth(4) }); // below the 5 ETH goal
      await expect(spend(eth(1))).to.be.revertedWith("Goal not reached yet");
    });

    it("requires a receipt", async function () {
      await reachGoal();
      await expect(spend(eth(1), { hash: ethers.ZeroHash })).to.be.revertedWith("A receipt is required");
    });

    it("rejects a receipt that was already used", async function () {
      await reachGoal();
      await spend(eth(1), { hash: RECEIPT_1 });
      await expect(spend(eth(1), { hash: RECEIPT_1 })).to.be.revertedWith("This receipt has already been used");
      await expect(spend(eth(1), { hash: RECEIPT_2 })).to.emit(tracker, "ExpenditureLogged"); // a new receipt is fine
    });

    it("does not let the NGO pay itself or the platform owner", async function () {
      await reachGoal();
      await expect(spend(eth(1), { to: ngo.address })).to.be.revertedWith("Recipient cannot be the NGO or the platform owner");
      await expect(spend(eth(1), { to: owner.address })).to.be.revertedWith("Recipient cannot be the NGO or the platform owner");
      await expect(spend(eth(1), { to: ethers.ZeroAddress })).to.be.revertedWith("Invalid recipient");
    });

    it("cannot spend more than the remaining balance", async function () {
      await reachGoal(); // 5 ETH
      await spend(eth(4), { hash: RECEIPT_1 });
      await expect(spend(eth(2), { hash: RECEIPT_2 })).to.be.revertedWith("Amount exceeds remaining balance");
    });

    it("rejects an empty description or zero amount", async function () {
      await reachGoal();
      await expect(spend(eth(1), { desc: "" })).to.be.revertedWith("Description is required");
      await expect(spend(0)).to.be.revertedWith("Amount must be greater than 0");
    });

    it("records and pays nothing when an audit check fails", async function () {
      await reachGoal();
      await expect(spend(eth(1), { hash: ethers.ZeroHash })).to.be.reverted;
      expect((await tracker.getExpenditures(1)).length).to.equal(0);
      expect(await ethers.provider.getBalance(await tracker.getAddress())).to.equal(eth(5));
    });
  });

  describe("Refunds", function () {
    it("are not available before the deadline", async function () {
      await tracker.connect(donor1).donate(1, { value: eth(1) });
      expect(await tracker.isRefundable(1)).to.equal(false);
      await expect(tracker.connect(donor1).claimRefund(1)).to.be.revertedWith("Refunds are not available for this cause");
    });

    it("are not available if the goal was reached", async function () {
      await reachGoal();
      await time.increaseTo(deadline + 1);
      await expect(tracker.connect(donor1).claimRefund(1)).to.be.revertedWith("Refunds are not available for this cause");
    });

    it("return each donor's exact contribution once the goal is missed", async function () {
      await tracker.connect(donor1).donate(1, { value: eth(1.5) });
      await tracker.connect(donor1).donate(1, { value: eth(0.5) });
      await tracker.connect(donor2).donate(1, { value: eth(1) });
      await time.increaseTo(deadline + 1);

      const tx = tracker.connect(donor1).claimRefund(1);
      await expect(tx).to.emit(tracker, "RefundClaimed").withArgs(1, donor1.address, eth(2));
      await expect(tx).to.changeEtherBalances([tracker, donor1], [-eth(2), eth(2)]);
      expect(await tracker.contributions(1, donor1.address)).to.equal(0);
      expect(await tracker.getRemainingBalance(1)).to.equal(eth(1)); // donor2's share still held
    });

    it("cannot be claimed twice or by non-donors", async function () {
      await tracker.connect(donor1).donate(1, { value: eth(1) });
      await time.increaseTo(deadline + 1);
      await tracker.connect(donor1).claimRefund(1);
      await expect(tracker.connect(donor1).claimRefund(1)).to.be.revertedWith("Nothing to refund");
      await expect(tracker.connect(stranger).claimRefund(1)).to.be.revertedWith("Nothing to refund");
    });
  });

  describe("Totals and balances", function () {
    it("track raised, spent and remaining across the full flow", async function () {
      await reachGoal(); // 5 ETH raised
      await spend(eth(2), { hash: RECEIPT_1 });
      await spend(eth(1.5), { hash: RECEIPT_2, desc: "Tents" });

      const cause = await tracker.getCause(1);
      expect(cause.totalRaised).to.equal(eth(5));
      expect(cause.totalSpent).to.equal(eth(3.5));
      expect(await tracker.getRemainingBalance(1)).to.equal(eth(1.5));
      expect(await ethers.provider.getBalance(await tracker.getAddress())).to.equal(eth(1.5));
    });
  });
});
