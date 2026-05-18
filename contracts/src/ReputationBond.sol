// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  ReputationBond
/// @notice Prices the maintainer's reputation on-chain. Users stake USDC
///         behind iterativv's blacklist record; the contract tracks her hit
///         rate over the last 30 resolved markets and slashes stakes when it
///         falls below the 70% floor.
/// @dev    project.md Phase 1 (1d).
///
///         Accounting:
///         - Principal uses a share/index vault model so a slash can mark down
///           every stake in O(1) (no looping over stakers).
///         - The 0.8% protocol-fee income is distributed via a MasterChef-style
///           accumulator — stakers claim pro-rata via claimFees().
///
///         Design note (deviates from project.md's literal text): project.md
///         says slashed USDC "redistributes to remaining bondholders", which is
///         circular — every staked address is slashed. Here a slash sends the
///         forfeited USDC to the treasury, and the staker *reward* is the 0.8%
///         fee pool. Coherent bond: earn fees, risk slashing.
contract ReputationBond is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- constants ---------------------------------------------------------
    uint256 public constant WINDOW = 30; // rolling resolved-market window
    uint256 public constant FLOOR_BPS = 7000; // 70% hit-rate slash floor
    uint256 public constant COOLDOWN = 4 hours; // unstake cooldown
    uint256 private constant ACC = 1e18; // fee-accumulator precision

    // --- immutables --------------------------------------------------------
    IERC20 public immutable usdc;
    address public immutable treasury; // receives slashed USDC

    // --- roles -------------------------------------------------------------
    address public resolution; // only address allowed to call recordOutcome

    // --- stake vault (share/index model) ----------------------------------
    uint256 public totalShares;
    uint256 public totalAssets; // USDC principal backing all shares
    mapping(address => uint256) public sharesOf;

    // --- unstake cooldown --------------------------------------------------
    mapping(address => uint256) public pendingShares; // shares queued for withdrawal
    mapping(address => uint256) public pendingUnlockAt;

    // --- rolling hit-rate window ------------------------------------------
    bool[WINDOW] private _outcomes;
    uint256 private _index; // next write slot
    uint256 public outcomeCount; // markets recorded (caps at WINDOW)
    uint256 public hitCount; // hits within the current window

    // --- fee accumulator ---------------------------------------------------
    uint256 public accFeePerShare; // scaled by ACC
    mapping(address => uint256) public feeDebt;

    // --- events ------------------------------------------------------------
    event Staked(address indexed user, uint256 amount, uint256 shares);
    event UnstakeInitiated(address indexed user, uint256 shares, uint256 unlockAt);
    event Unstaked(address indexed user, uint256 shares, uint256 amount);
    event OutcomeRecorded(uint256 indexed marketId, bool yesWon, uint256 hitRateBps);
    event Slashed(uint256 hitRateBps, uint256 amount);
    event FeesDeposited(uint256 amount, uint256 accFeePerShare);
    event FeesClaimed(address indexed user, uint256 amount);
    event ResolutionUpdated(address indexed resolution);

    error ZeroAddress();
    error ZeroAmount();
    error NotResolution();
    error InsufficientShares();
    error PendingExists();
    error NothingPending();
    error CooldownActive();

    constructor(address _usdc, address _treasury) Ownable(msg.sender) {
        if (_usdc == address(0) || _treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        treasury = _treasury;
    }

    modifier onlyResolution() {
        if (msg.sender != resolution) revert NotResolution();
        _;
    }

    /// @notice Set the Resolution contract — the only caller of recordOutcome.
    function setResolution(address _resolution) external onlyOwner {
        if (_resolution == address(0)) revert ZeroAddress();
        resolution = _resolution;
        emit ResolutionUpdated(_resolution);
    }

    // ======================================================================
    //  Staking
    // ======================================================================

    /// @notice Stake USDC behind the maintainer's record.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _harvest(msg.sender);

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 shares = totalShares == 0 ? amount : (amount * totalShares) / totalAssets;
        if (shares == 0) revert ZeroAmount();

        sharesOf[msg.sender] += shares;
        totalShares += shares;
        totalAssets += amount;

        feeDebt[msg.sender] = (sharesOf[msg.sender] * accFeePerShare) / ACC;
        emit Staked(msg.sender, amount, shares);
    }

    /// @notice Begin unstaking `shares`. Funds remain staked — and fully
    ///         slashable — for the 4h cooldown, then claimUnstake() withdraws.
    function unstake(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        if (shares > sharesOf[msg.sender]) revert InsufficientShares();
        if (pendingShares[msg.sender] != 0) revert PendingExists();

        pendingShares[msg.sender] = shares;
        pendingUnlockAt[msg.sender] = block.timestamp + COOLDOWN;
        emit UnstakeInitiated(msg.sender, shares, block.timestamp + COOLDOWN);
    }

    /// @notice Withdraw queued shares as USDC once the cooldown has elapsed.
    function claimUnstake() external nonReentrant {
        uint256 shares = pendingShares[msg.sender];
        if (shares == 0) revert NothingPending();
        if (block.timestamp < pendingUnlockAt[msg.sender]) revert CooldownActive();

        _harvest(msg.sender);

        uint256 amount = (shares * totalAssets) / totalShares;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        totalAssets -= amount;
        pendingShares[msg.sender] = 0;
        pendingUnlockAt[msg.sender] = 0;

        feeDebt[msg.sender] = (sharesOf[msg.sender] * accFeePerShare) / ACC;
        usdc.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, shares, amount);
    }

    // ======================================================================
    //  Outcome recording + slashing
    // ======================================================================

    /// @notice Record a resolved market into the rolling window. `yesWon` is
    ///         true when the coin rugged (a hit). Slashes if hit rate < 70%.
    function recordOutcome(uint256 marketId, bool yesWon) external onlyResolution {
        if (outcomeCount == WINDOW) {
            // window full — drop the oldest outcome being overwritten
            if (_outcomes[_index]) hitCount -= 1;
        } else {
            outcomeCount += 1;
        }
        _outcomes[_index] = yesWon;
        if (yesWon) hitCount += 1;
        _index = (_index + 1) % WINDOW;

        uint256 rate = getHitRate();
        emit OutcomeRecorded(marketId, yesWon, rate);

        if (rate < FLOOR_BPS) _slash(rate);
    }

    /// @dev Marks down every stake by the shortfall below the floor.
    function _slash(uint256 hitRateBps) internal {
        uint256 shortfallBps = FLOOR_BPS - hitRateBps;
        uint256 amount = (totalAssets * shortfallBps) / 10_000;
        if (amount == 0) return;

        totalAssets -= amount;
        usdc.safeTransfer(treasury, amount);
        emit Slashed(hitRateBps, amount);
    }

    // ======================================================================
    //  Protocol-fee pool (the 0.8% bondholder cut)
    // ======================================================================

    /// @notice Deposit protocol-fee income for stakers. Caller must approve
    ///         `amount` first. If there are no stakers, fees route to treasury.
    function depositFees(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        if (totalShares == 0) {
            usdc.safeTransfer(treasury, amount);
        } else {
            accFeePerShare += (amount * ACC) / totalShares;
        }
        emit FeesDeposited(amount, accFeePerShare);
    }

    /// @notice Claim accumulated fee income.
    function claimFees() external nonReentrant {
        _harvest(msg.sender);
    }

    /// @dev Pays out any pending fees and resets the user's fee debt.
    function _harvest(address user) internal {
        uint256 shares = sharesOf[user];
        if (shares > 0) {
            uint256 accrued = (shares * accFeePerShare) / ACC;
            uint256 pending = accrued - feeDebt[user];
            if (pending > 0) {
                feeDebt[user] = accrued;
                usdc.safeTransfer(user, pending);
                emit FeesClaimed(user, pending);
            }
        }
    }

    // ======================================================================
    //  Views
    // ======================================================================

    /// @notice Current hit rate in basis points (8200 = 82%). 100% if empty.
    function getHitRate() public view returns (uint256) {
        if (outcomeCount == 0) return 10_000;
        return (hitCount * 10_000) / outcomeCount;
    }

    /// @notice USDC principal currently backing `user`'s stake.
    function assetsOf(address user) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (sharesOf[user] * totalAssets) / totalShares;
    }

    /// @notice Unclaimed fee income for `user`.
    function pendingFees(address user) external view returns (uint256) {
        return (sharesOf[user] * accFeePerShare) / ACC - feeDebt[user];
    }
}
