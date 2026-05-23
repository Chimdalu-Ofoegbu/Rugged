// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReputationBond} from "./interfaces/IReputationBond.sol";

/// @title  Market
/// @notice A single 24-hour binary market: "Will [coin] drop >50% from its
///         blacklist-time price?" Holds YES/NO USDC pools, settles via the
///         Resolution contract, and pays winners pull-style.
/// @dev    project.md Phase 1 (1b). Deployed by MarketFactory.
///
///         Fee model (project.md §7): a 2% fee is taken from the winnings
///         (the losing pool) at settlement — 1.2% to treasury, 0.8% to the
///         ReputationBond fee pool. No fee on a bettor's own returned stake;
///         no fee on losing bets. "Rugged takes 2% of your winnings."
///
///         Design notes:
///         - USYC parking is intentionally omitted in Phase 1 (the Teller
///           allowlist can't cover dynamically-created markets; yield is
///           immaterial at 24h windows). The contract simply escrows USDC.
///         - Paymaster gas-abstraction is an ERC-4337 UserOp-layer concern,
///           wired in the backend — no contract code here.
contract Market is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Default window if the factory passes 0 to the duration param.
    uint256 public constant DEFAULT_DURATION = 24 hours;
    uint256 private constant TREASURY_BPS = 120; // 1.2%
    uint256 private constant BOND_BPS = 80; // 0.8%

    // --- immutable market parameters --------------------------------------
    IERC20 public immutable usdc;
    uint256 public immutable marketId;
    address public immutable coinAddress;
    uint256 public immutable blacklistTimestamp;
    uint256 public immutable blacklistPrice; // resolution baseline
    uint256 public immutable seedProbabilityBps; // swarm consensus seed
    uint256 public immutable expiry;
    address public immutable resolution;
    address public immutable treasury;
    address public immutable reputationBond;

    // --- betting pools -----------------------------------------------------
    uint256 public yesPool;
    uint256 public noPool;
    mapping(address => uint256) public yesStake;
    mapping(address => uint256) public noStake;

    // --- resolution state --------------------------------------------------
    bool public resolved;
    bool public yesWon;
    uint256 public winningPool; // pool size of the winning side at settlement
    uint256 public distributable; // losing pool minus fee — split among winners
    mapping(address => bool) public claimed;

    event BetPlaced(address indexed bettor, bool isYes, uint256 amount);
    event BetCancelled(address indexed bettor, bool isYes, uint256 amount);
    event Settled(bool yesWon, uint256 winningPool, uint256 distributable, uint256 fee);
    event Claimed(address indexed bettor, uint256 payout);

    error ZeroAmount();
    error BettingClosed();
    error AlreadyResolved();
    error NotResolution();
    error NotResolved();
    error NotYetExpired();
    error AlreadyClaimed();
    error NothingToClaim();
    error NothingToCancel();

    constructor(
        address _usdc,
        uint256 _marketId,
        address _coinAddress,
        uint256 _blacklistTimestamp,
        uint256 _blacklistPrice,
        uint256 _seedProbabilityBps,
        uint256 _duration,
        address _resolution,
        address _treasury,
        address _reputationBond
    ) {
        usdc = IERC20(_usdc);
        marketId = _marketId;
        coinAddress = _coinAddress;
        blacklistTimestamp = _blacklistTimestamp;
        blacklistPrice = _blacklistPrice;
        seedProbabilityBps = _seedProbabilityBps;
        // Duration of 0 means "use the canonical 24h window" — keeps the
        // factory's calling convention backward-compatible for callers that
        // don't care about short demo markets.
        expiry = _blacklistTimestamp + (_duration == 0 ? DEFAULT_DURATION : _duration);
        resolution = _resolution;
        treasury = _treasury;
        reputationBond = _reputationBond;
    }

    /// @notice Place a USDC bet on YES (rugs) or NO (survives). Caller must
    ///         approve `amount` first.
    function placeBet(bool isYes, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp >= expiry) revert BettingClosed();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (isYes) {
            yesPool += amount;
            yesStake[msg.sender] += amount;
        } else {
            noPool += amount;
            noStake[msg.sender] += amount;
        }
        emit BetPlaced(msg.sender, isYes, amount);
    }

    /// @notice Withdraw the full stake on the chosen side and exit the
    ///         market. Only valid while the market is open (pre-expiry,
    ///         unresolved). Refunds 100% of the stake — no fee.
    /// @dev    No partial cancels: this is "I changed my mind" UX, not
    ///         a trading primitive. Users can re-enter via placeBet.
    function cancelBet(bool isYes) external nonReentrant {
        if (resolved) revert AlreadyResolved();
        if (block.timestamp >= expiry) revert BettingClosed();

        uint256 stake = isYes ? yesStake[msg.sender] : noStake[msg.sender];
        if (stake == 0) revert NothingToCancel();

        if (isYes) {
            yesStake[msg.sender] = 0;
            yesPool -= stake;
        } else {
            noStake[msg.sender] = 0;
            noPool -= stake;
        }

        usdc.safeTransfer(msg.sender, stake);
        emit BetCancelled(msg.sender, isYes, stake);
    }

    /// @notice Current implied probabilities in basis points (yesBps + noBps
    ///         = 10000). Before any bets, returns the swarm consensus seed.
    function getOdds() external view returns (uint256 yesBps, uint256 noBps) {
        uint256 total = yesPool + noPool;
        if (total == 0) {
            return (seedProbabilityBps, 10_000 - seedProbabilityBps);
        }
        yesBps = (yesPool * 10_000) / total;
        noBps = 10_000 - yesBps;
    }

    /// @notice Settle the market. Called only by Resolution, only after expiry.
    function settle(bool _yesWon) external nonReentrant {
        if (msg.sender != resolution) revert NotResolution();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < expiry) revert NotYetExpired();

        resolved = true;
        yesWon = _yesWon;

        uint256 winPool = _yesWon ? yesPool : noPool;
        uint256 losePool = _yesWon ? noPool : yesPool;
        winningPool = winPool;

        if (winPool == 0) {
            // No winners — the at-risk pool goes to the treasury.
            if (losePool > 0) usdc.safeTransfer(treasury, losePool);
            emit Settled(_yesWon, 0, 0, 0);
            return;
        }

        uint256 treasuryCut = (losePool * TREASURY_BPS) / 10_000;
        uint256 bondCut = (losePool * BOND_BPS) / 10_000;
        uint256 fee = treasuryCut + bondCut;
        distributable = losePool - fee;

        if (treasuryCut > 0) usdc.safeTransfer(treasury, treasuryCut);
        if (bondCut > 0) {
            usdc.forceApprove(reputationBond, bondCut);
            IReputationBond(reputationBond).depositFees(bondCut);
        }
        emit Settled(_yesWon, winPool, distributable, fee);
    }

    /// @notice Claim winnings after settlement: your stake back plus your
    ///         pro-rata share of the (post-fee) losing pool.
    function claim() external nonReentrant {
        if (!resolved) revert NotResolved();
        if (claimed[msg.sender]) revert AlreadyClaimed();

        uint256 stake = yesWon ? yesStake[msg.sender] : noStake[msg.sender];
        if (stake == 0) revert NothingToClaim();

        claimed[msg.sender] = true;
        uint256 winnings = (stake * distributable) / winningPool;
        uint256 payout = stake + winnings;

        usdc.safeTransfer(msg.sender, payout);
        emit Claimed(msg.sender, payout);
    }
}
