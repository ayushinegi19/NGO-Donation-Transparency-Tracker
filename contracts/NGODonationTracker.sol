// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NGO Donation Transparency Tracker
/// @notice NGOs create causes and donors send ETH to this contract until the goal is reached.
///         The NGO spends the funds with logExpenditure(), which runs an automatic audit
///         (compulsory, never-reused receipt; no self-payment; enough funds) and, if every
///         check passes, pays the recipient directly and records the expenditure permanently.
///         If a cause misses its goal by the deadline, donors can claim refunds.
contract NGODonationTracker {
    enum Category { Disaster, Education, Health, Food, Other }
    /// Who is behind a cause, as checked by the owner off-chain: a registered NGO / organisation,
    /// or an individual raising money for a personal cause (e.g. medical treatment).
    enum CreatorType { Unverified, Organisation, Individual }

    struct Cause {
        uint256 id;
        address ngo;            // creator of the cause; the only address that can spend its funds
        string title;
        string description;
        Category category;
        uint256 goal;           // in wei; donations close and spending opens once this is reached
        uint256 deadline;       // unix timestamp; no donations accepted after this
        uint256 totalRaised;
        uint256 totalSpent;     // paid out to recipients
        uint256 totalRefunded;  // returned to donors
    }

    struct Donation {
        address donor;
        uint256 amount;
        uint256 timestamp;
    }

    struct Expenditure {
        string description;
        uint256 amount;
        address recipient;
        bytes32 receiptHash;    // SHA-256 of the receipt PDF (computed in the browser); compulsory
        string receiptURI;      // optional link to the receipt, e.g. an IPFS URL
        uint256 timestamp;      // when it was paid
    }

    address public owner;                                // platform admin; verifies cause creators
    mapping(address => CreatorType) public creatorType;  // verification badge, does not block anyone

    uint256 public causeCount;
    mapping(uint256 => Cause) private causes;
    mapping(uint256 => Donation[]) private donations;
    mapping(uint256 => Expenditure[]) private expenditures;
    mapping(uint256 => mapping(address => uint256)) public contributions; // causeId => donor => amount
    mapping(bytes32 => bool) public receiptUsed;         // a receipt can back only one expenditure

    event CreatorVerified(address indexed creator, CreatorType creatorType);
    event CauseCreated(uint256 indexed causeId, address indexed ngo, string title, Category category, uint256 goal, uint256 deadline);
    event DonationReceived(uint256 indexed causeId, address indexed donor, uint256 amount);
    event ExpenditureLogged(uint256 indexed causeId, uint256 indexed expenseId, address recipient, uint256 amount, string description, bytes32 receiptHash);
    event RefundClaimed(uint256 indexed causeId, address indexed donor, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can do this");
        _;
    }

    modifier causeExists(uint256 _causeId) {
        require(_causeId > 0 && _causeId <= causeCount, "Cause does not exist");
        _;
    }

    modifier onlyNGO(uint256 _causeId) {
        require(msg.sender == causes[_causeId].ngo, "Only the cause's NGO can do this");
        _;
    }

    /// @param _owner Platform admin. Passing it in lets a separate account do the deployment,
    ///        so the admin's wallet (MetaMask) never sends transactions outside MetaMask.
    constructor(address _owner) {
        require(_owner != address(0), "Invalid owner");
        owner = _owner;
    }

    // ---------------------------------------------------------------- Admin

    /// @notice Owner records who is behind an address after checking documents off-chain:
    ///         Organisation (registered NGO) or Individual (personal cause). Unverified removes it.
    function setCreatorType(address _creator, CreatorType _type) external onlyOwner {
        require(_creator != address(0), "Invalid address");
        creatorType[_creator] = _type;
        emit CreatorVerified(_creator, _type);
    }

    // ---------------------------------------------------------------- Causes and donations

    /// @notice Create a new cause. The caller becomes its NGO.
    function createCause(
        string memory _title,
        string memory _description,
        Category _category,
        uint256 _goal,
        uint256 _deadline
    ) external {
        require(msg.sender != owner, "The platform owner cannot create causes");
        require(bytes(_title).length > 0, "Title is required");
        require(_goal > 0, "Goal must be greater than 0");
        require(_deadline > block.timestamp, "Deadline must be in the future");

        causeCount++;
        Cause storage c = causes[causeCount];
        c.id = causeCount;
        c.ngo = msg.sender;
        c.title = _title;
        c.description = _description;
        c.category = _category;
        c.goal = _goal;
        c.deadline = _deadline;

        emit CauseCreated(causeCount, msg.sender, _title, _category, _goal, _deadline);
    }

    /// @notice Donate ETH to a cause. The amount is tracked per donor so it can be refunded.
    /// @dev The donation that reaches the goal may go over it; after that, donations are closed.
    function donate(uint256 _causeId) external payable causeExists(_causeId) {
        require(msg.value > 0, "Donation must be greater than 0");
        require(block.timestamp <= causes[_causeId].deadline, "Cause deadline has passed");
        require(causes[_causeId].totalRaised < causes[_causeId].goal, "Goal reached, donations are closed");

        causes[_causeId].totalRaised += msg.value;
        contributions[_causeId][msg.sender] += msg.value;
        donations[_causeId].push(Donation(msg.sender, msg.value, block.timestamp));

        emit DonationReceived(_causeId, msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- Spending with automatic audit

    /// @notice The NGO spends funds on the cause. Every rule below is an automatic audit check;
    ///         if any fails the whole transaction is rejected and nothing is paid. If all pass,
    ///         the ETH goes straight to the recipient and the expenditure is recorded forever.
    function logExpenditure(
        uint256 _causeId,
        string memory _description,
        uint256 _amount,
        address _recipient,
        bytes32 _receiptHash,
        string memory _receiptURI
    ) external causeExists(_causeId) onlyNGO(_causeId) {
        Cause storage c = causes[_causeId];
        require(c.totalRaised >= c.goal, "Goal not reached yet");
        require(bytes(_description).length > 0, "Description is required");
        require(_amount > 0, "Amount must be greater than 0");
        require(_amount <= getRemainingBalance(_causeId), "Amount exceeds remaining balance");
        require(_recipient != address(0), "Invalid recipient");
        require(_recipient != c.ngo && _recipient != owner, "Recipient cannot be the NGO or the platform owner");
        require(_receiptHash != bytes32(0), "A receipt is required");
        require(!receiptUsed[_receiptHash], "This receipt has already been used");

        // Update state before sending ETH (checks-effects-interactions)
        receiptUsed[_receiptHash] = true;
        c.totalSpent += _amount;
        expenditures[_causeId].push(Expenditure(_description, _amount, _recipient, _receiptHash, _receiptURI, block.timestamp));

        (bool sent, ) = payable(_recipient).call{value: _amount}("");
        require(sent, "ETH transfer failed");

        emit ExpenditureLogged(_causeId, expenditures[_causeId].length - 1, _recipient, _amount, _description, _receiptHash);
    }

    // ---------------------------------------------------------------- Refunds

    /// @notice If the deadline passed without reaching the goal, a donor withdraws their own donation.
    /// @dev Pull-payment pattern: the balance is zeroed before sending, so reentrancy cannot double-refund.
    function claimRefund(uint256 _causeId) external causeExists(_causeId) {
        require(isRefundable(_causeId), "Refunds are not available for this cause");
        uint256 amount = contributions[_causeId][msg.sender];
        require(amount > 0, "Nothing to refund");

        contributions[_causeId][msg.sender] = 0;
        causes[_causeId].totalRefunded += amount;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Refund transfer failed");

        emit RefundClaimed(_causeId, msg.sender, amount);
    }

    // ---------------------------------------------------------------- Views

    function getCause(uint256 _causeId) external view causeExists(_causeId) returns (Cause memory) {
        return causes[_causeId];
    }

    /// @notice Refunds open once the deadline has passed and the goal was not reached.
    function isRefundable(uint256 _causeId) public view causeExists(_causeId) returns (bool) {
        Cause storage c = causes[_causeId];
        return block.timestamp > c.deadline && c.totalRaised < c.goal;
    }

    /// @notice ETH still held by the contract for this cause.
    function getRemainingBalance(uint256 _causeId) public view causeExists(_causeId) returns (uint256) {
        Cause storage c = causes[_causeId];
        return c.totalRaised - c.totalSpent - c.totalRefunded;
    }

    function getDonations(uint256 _causeId) external view causeExists(_causeId) returns (Donation[] memory) {
        return donations[_causeId];
    }

    function getExpenditures(uint256 _causeId) external view causeExists(_causeId) returns (Expenditure[] memory) {
        return expenditures[_causeId];
    }
}
