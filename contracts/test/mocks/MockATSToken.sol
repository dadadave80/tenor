// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ThirdPartyType} from "@ats/domain/asset/types/ThirdPartyType.sol";
import {IHoldTypes} from "@ats/facets/hold/IHoldTypes.sol";

/// @title MockATSToken
/// @author David Dada <daveproxy80@gmail.com> (https://github.com/dadadave80)
/// @notice Stand-in for the ATS security-token diamond: enough ERC-20 to be useful, plus the four
///         `*HoldByPartition` writes Tenor drives — reproducing the REAL third-party allowance mechanic that
///         FR1 and invariant 7 rest on.
/// @dev Types, hold events and hold errors are INHERITED from the production `IHoldTypes`, so the hold ABI a
///      test (or the web client's decoder) sees here is identical to the token's on testnet. `IHoldTypes` pulls
///      in nothing but `ThirdPartyType`, so the import costs no further ATS dependency. The compliance errors
///      that live in OTHER ATS interfaces are redeclared locally under their exact upstream name and signature
///      — importing those interfaces would drag in the whole ATS graph, while an identical signature yields an
///      identical selector. Each redeclaration names its upstream file.
///
///      **Balance model, mirroring ATS.** Hold creation calls `reducePartitionOnly`, which drains the
///      PARTITION balance and leaves the aggregate ERC-20 balance alone. So `balanceOf` keeps counting held
///      tokens and a holder's TRANSFERABLE balance is `balanceOf - heldBalance`. `TenorCoupon` reads
///      `balanceOf`, so a seller with a live listing still earns their full coupon — intended behaviour, not
///      an accident of the mock.
///
///      **Where compliance is enforced.** `executeHoldByPartition` enforces KYC on both parties, the control
///      list and pause, because that is where ATS enforces them (`onlyIdentifiedAddresses`, `onlyCompliant`,
///      `onlyUnpaused`, plus a blocked-holder check inside `_validateExecuteHold`). Hold CREATION deliberately
///      does NOT: `createHoldFromByPartition` carries no KYC or control-list modifier upstream, so an
///      unverified seller can list and only the fill fails. That asymmetry is load-bearing for Tenor's demo.
///
///      **Revert precedence matches ATS exactly** — each function spells out its order. A test that stacks two
///      failures asserts on the first one, so the order is part of the contract.
///
///      **Plain ERC-20 transfers are compliance-light on purpose.** `transfer` / `transferFrom` check pause,
///      the zero address and the transferable balance, but NOT KYC or the control list: `kyc` starts empty, so
///      enforcing it would make every setup transfer revert until a test granted KYC. Tenor never calls either
///      function on the security token. Use `mint` or `transfer` freely for setup.
contract MockATSToken is IHoldTypes {
    //*//////////////////////////////////////////////////////////////////////////
    //                                  STORAGE
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice ERC-20 token name.
    string public name;
    /// @notice ERC-20 token symbol.
    string public symbol;
    /// @notice ERC-20 decimals. `TenorMarket` caches this per listing (SPEC [DEV-6]).
    uint8 public decimals;
    /// @notice Total tokens issued through {mint}.
    uint256 public totalSupply;

    /// @notice Aggregate balance per account — INCLUDES tokens under hold, exactly as ATS reports it.
    mapping(address account => uint256) public balanceOf;
    /// @notice ERC-20 allowance. The seller's allowance to the Tenor diamond is what bounds every listing.
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    /// @notice Tokens under hold per account. `balanceOf - heldBalance` is what can move freely.
    mapping(address account => uint256) public heldBalance;

    /// @notice KYC register. Both parties to a hold execution must be granted. Steer with {setKyc}.
    mapping(address account => bool) public kyc;
    /// @notice Control-list register. A blocked holder or recipient cannot settle. Steer with {setBlocked}.
    mapping(address account => bool) public blocked;
    /// @notice Token-level pause. Blocks all four hold operations and plain transfers. Steer with {setPaused}.
    bool public paused;

    /// @notice Last hold id handed out for a (partition, holder) pair. Ids are sequential from 1 and the
    ///         counter NEVER resets, so a drained hold's id is never reissued — ATS behaves the same way.
    mapping(bytes32 partition => mapping(address holder => uint256 lastId)) public lastHoldId;
    /// @notice The address whose allowance opened each hold, and the one release / reclaim restores it to.
    /// @dev THE mechanic invariant 7 tests. Keyed (partition, holder, holdId) to match {HoldIdentifier}'s field
    ///      order; ATS keys the same data (holder, partition, holdId).
    mapping(bytes32 partition => mapping(address holder => mapping(uint256 holdId => address thirdParty))) public
        holdThirdParty;

    /// @dev Live hold records, keyed (partition, holder, holdId). `id == 0` means "no such hold": ids start at
    ///      1 and a drained hold is deleted, which is why a stale identifier reverts {WrongHoldId}.
    mapping(bytes32 partition => mapping(address holder => mapping(uint256 holdId => HoldData))) private _holds;

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ERRORS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice The token is paused. Redeclared from `@ats/facets/pause/IPause.sol`.
    error IsPaused();

    /// @notice An account involved in the transfer is not KYC-granted.
    /// @dev Redeclared from `@ats/facets/kyc/IKyc.sol`. Upstream carries no argument — ATS appends the
    ///      offending account as raw revert data behind this selector — so neither does this one.
    error InvalidKycStatus();

    /// @notice An account involved in the transfer is on the control list.
    /// @dev Redeclared from `@ats/infrastructure/errors/ICommonErrors.sol`.
    /// @param account The blocked account.
    error AccountIsBlocked(address account);

    /// @notice The zero address was supplied where an account is required.
    /// @dev Redeclared from `@ats/infrastructure/errors/ICommonErrors.sol`.
    error ZeroAddressNotAllowed();

    /// @notice The hold's expiration timestamp is not acceptable.
    /// @dev Redeclared from `@ats/infrastructure/errors/ICommonErrors.sol`.
    error WrongExpirationTimestamp();

    /// @notice The spender's allowance does not cover the requested amount.
    /// @dev Redeclared from `@ats/facets/allowance/IAllowanceTypes.sol`; note the (spender, from) arg order.
    /// @param spender The account spending the allowance — for a listing, the Tenor diamond.
    /// @param from The account that granted it.
    error InsufficientAllowance(address spender, address from);

    /// @notice The account's transferable balance does not cover the requested amount.
    /// @dev Redeclared from `@ats/facets/transfer/ITransfer.sol`.
    /// @param account The account short of tokens.
    /// @param balance Its TRANSFERABLE balance (`balanceOf - heldBalance`), which is what ATS reports here.
    /// @param value The amount requested.
    /// @param partition The partition the operation targeted.
    error InsufficientBalance(address account, uint256 balance, uint256 value, bytes32 partition);

    //*//////////////////////////////////////////////////////////////////////////
    //                                   EVENTS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice ERC-20 transfer. A hold is modelled as a burn on creation and a mint on settlement, because
    ///         that is what ATS emits (`_emitHoldCreationEvents` / `_emitHoldTransfer`).
    /// @param from The sender, or the zero address when a hold settles.
    /// @param to The recipient, or the zero address when a hold is created.
    /// @param value The amount moved.
    event Transfer(address indexed from, address indexed to, uint256 value);

    /// @notice ERC-20 approval, emitted on {approve} and on every allowance restoration.
    /// @param owner The token holder.
    /// @param spender The approved spender.
    /// @param value The new total allowance.
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice TEST STEERING — the KYC register changed.
    /// @param account The account whose status changed.
    /// @param granted True when KYC is granted.
    event KycSet(address indexed account, bool granted);

    /// @notice TEST STEERING — the control list changed.
    /// @param account The account whose status changed.
    /// @param isBlocked True when the account is blocked.
    event BlockedSet(address indexed account, bool isBlocked);

    /// @notice TEST STEERING — the token pause flag changed.
    /// @param isPaused The new pause state.
    event PausedSet(bool isPaused);

    //*//////////////////////////////////////////////////////////////////////////
    //                                 CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Deploys the stand-in.
    /// @dev Solidity has no default arguments, so `decimals_` is explicit: pass 6 for Tenor's instrument
    ///      ("Tenor Green Note 2027", SPEC §11.1.4). Zero is a legitimate value for a whole-unit bond and is
    ///      stored as given, never reinterpreted.
    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol.
    /// @param decimals_ ERC-20 decimals.
    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                TEST HELPERS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice TEST HELPER — issues `amount` to `to`, no compliance checks. Stands in for an ATS issuance.
    /// @param to The receiving account.
    /// @param amount The amount to issue.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert ZeroAddressNotAllowed();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice TEST HELPER — grants or revokes KYC, standing in for the issuer's ATS action.
    /// @param account The account to update.
    /// @param granted True to grant KYC, false to revoke it.
    function setKyc(address account, bool granted) external {
        kyc[account] = granted;
        emit KycSet(account, granted);
    }

    /// @notice TEST HELPER — adds or removes `account` from the control list (an ATS freeze).
    /// @param account The account to update.
    /// @param isBlocked True to block the account.
    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
        emit BlockedSet(account, isBlocked);
    }

    /// @notice TEST HELPER — pauses or unpauses the token, standing in for the issuer pausing in ATS.
    /// @param isPaused True to pause.
    function setPaused(bool isPaused) external {
        paused = isPaused;
        emit PausedSet(isPaused);
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   ERC-20
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Sets `spender`'s allowance to `amount`. For a seller this is the "enable selling" step, and the
    ///         allowance granted to the Tenor diamond is the seller's self-imposed selling cap.
    /// @param spender The account allowed to spend.
    /// @param amount The new allowance.
    /// @return success_ Always true; reverts otherwise.
    function approve(address spender, uint256 amount) external returns (bool success_) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Moves `amount` of the caller's TRANSFERABLE balance to `to`.
    /// @param to The recipient.
    /// @param amount The amount to move.
    /// @return success_ Always true; reverts otherwise.
    function transfer(address to, uint256 amount) external returns (bool success_) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Spends the caller's allowance on `from` and moves `amount` to `to`.
    /// @dev Allowance first, then the balance check — the reverse of hold creation, which checks the balance
    ///      before the allowance.
    /// @param from The account whose tokens move.
    /// @param to The recipient.
    /// @param amount The amount to move.
    /// @return success_ Always true; reverts otherwise.
    function transferFrom(address from, address to, uint256 amount) external returns (bool success_) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance(msg.sender, from);
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   HOLDS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice Reserves `hold.amount` of `from`'s balance under a new hold, spending the ERC-20 allowance
    ///         `from` granted the CALLER and recording the caller as the hold's third party.
    /// @dev THE mechanic Tenor is built on. `holdThirdParty` is set to `msg.sender`, so {releaseHoldByPartition}
    ///      and {reclaimHoldByPartition} restore the allowance to that same address — invariant 7.
    ///
    ///      No KYC or control-list check here; ATS has none on this path (see the contract-level notes).
    ///      Revert precedence, matching ATS: {IsPaused} → {WrongExpirationTimestamp} →
    ///      {ZeroAddressNotAllowed} → {InvalidHoldAmount} → {InsufficientBalance} → {InsufficientAllowance}.
    ///      The allowance is checked LAST, after the balance.
    /// @param partition The partition to hold under.
    /// @param from The holder whose balance is reserved.
    /// @param hold The hold definition; `escrow` may execute it, `to == address(0)` lets the escrow pick.
    /// @param operatorData Operator payload, recorded verbatim.
    /// @return success_ Always true; reverts otherwise.
    /// @return holdId_ The new hold's id, sequential from 1 within (partition, from).
    function createHoldFromByPartition(bytes32 partition, address from, Hold calldata hold, bytes calldata operatorData)
        external
        returns (bool success_, uint256 holdId_)
    {
        if (paused) revert IsPaused();
        if (hold.expirationTimestamp <= block.timestamp) revert WrongExpirationTimestamp();
        if (from == address(0) || hold.escrow == address(0)) revert ZeroAddressNotAllowed();
        if (hold.amount == 0) revert InvalidHoldAmount();

        uint256 transferable = balanceOf[from] - heldBalance[from];
        if (transferable < hold.amount) revert InsufficientBalance(from, transferable, hold.amount, partition);

        uint256 allowed = allowance[from][msg.sender];
        if (allowed < hold.amount) revert InsufficientAllowance(msg.sender, from);
        allowance[from][msg.sender] = allowed - hold.amount;

        holdId_ = ++lastHoldId[partition][from];

        HoldData storage record = _holds[partition][from][holdId_];
        record.id = holdId_;
        record.hold.amount = hold.amount;
        record.hold.expirationTimestamp = hold.expirationTimestamp;
        record.hold.escrow = hold.escrow;
        record.hold.to = hold.to;
        record.hold.data = hold.data;
        record.operatorData = operatorData;
        record.thirdPartyType = ThirdPartyType.AUTHORIZED;

        holdThirdParty[partition][from][holdId_] = msg.sender;
        heldBalance[from] += hold.amount;

        emit Transfer(from, address(0), hold.amount);
        emit HeldFromByPartition(msg.sender, from, partition, holdId_, hold, operatorData);
        return (true, holdId_);
    }

    /// @notice Settles `amount` of a hold to `to`, moving the tokens out of the holder's balance.
    /// @dev Partial execution is supported: the hold's outstanding `amount` and the holder's `heldBalance` both
    ///      shrink, and the record is deleted only once drained. This is the call that makes Tenor's fill
    ///      compliance-native — every check below lives in the TOKEN, not in Tenor.
    ///
    ///      Revert precedence, matching ATS: {IsPaused} → {InvalidKycStatus} (holder, then `to`) →
    ///      {AccountIsBlocked}(`to`) → {WrongHoldId} → {AccountIsBlocked}(holder) →
    ///      {InvalidDestinationAddress} → {HoldExpirationReached} → {IsNotEscrow} → {InsufficientHoldBalance}.
    ///      Note {IsNotEscrow} is near the END: a non-escrow caller hitting an expired hold sees
    ///      {HoldExpirationReached} first.
    /// @param idf The (partition, tokenHolder, holdId) triple.
    /// @param to The recipient; must equal `hold.to` unless that is the zero address.
    /// @param amount The amount to settle, at most the hold's outstanding amount.
    /// @return success_ Always true; reverts otherwise.
    /// @return partition_ The hold's partition, echoed back.
    function executeHoldByPartition(HoldIdentifier calldata idf, address to, uint256 amount)
        external
        returns (bool success_, bytes32 partition_)
    {
        if (paused) revert IsPaused();
        if (idf.tokenHolder != address(0) && !kyc[idf.tokenHolder]) revert InvalidKycStatus();
        if (to != address(0) && !kyc[to]) revert InvalidKycStatus();
        if (blocked[to]) revert AccountIsBlocked(to);

        HoldData storage record = _holds[idf.partition][idf.tokenHolder][idf.holdId];
        if (record.id == 0) revert WrongHoldId();
        if (blocked[idf.tokenHolder]) revert AccountIsBlocked(idf.tokenHolder);
        if (record.hold.to != address(0) && to != record.hold.to) {
            revert InvalidDestinationAddress(record.hold.to, to);
        }
        if (block.timestamp >= record.hold.expirationTimestamp) revert HoldExpirationReached();
        if (msg.sender != record.hold.escrow) revert IsNotEscrow();
        if (amount > record.hold.amount) revert InsufficientHoldBalance(record.hold.amount, amount);

        record.hold.amount -= amount;
        heldBalance[idf.tokenHolder] -= amount;
        balanceOf[idf.tokenHolder] -= amount;
        balanceOf[to] += amount;
        if (record.hold.amount == 0) _removeHold(idf);

        emit Transfer(address(0), to, amount);
        emit HoldByPartitionExecuted(idf.tokenHolder, idf.partition, idf.holdId, amount, to);
        return (true, idf.partition);
    }

    /// @notice Returns `amount` from a live hold to the holder's available balance, restoring the third
    ///         party's allowance by exactly that much.
    /// @dev Before expiry only, and ESCROW ONLY — ATS runs the same escrow check on release as on execute,
    ///      which is what makes "only the diamond can cancel a listing" true at the token level.
    ///      Revert precedence: {IsPaused} → {WrongHoldId} → {HoldExpirationReached} → {IsNotEscrow} →
    ///      {InsufficientHoldBalance}.
    /// @param idf The (partition, tokenHolder, holdId) triple.
    /// @param amount The amount to release.
    /// @return success_ Always true; reverts otherwise.
    function releaseHoldByPartition(HoldIdentifier calldata idf, uint256 amount) external returns (bool success_) {
        if (paused) revert IsPaused();
        HoldData storage record = _holds[idf.partition][idf.tokenHolder][idf.holdId];
        if (record.id == 0) revert WrongHoldId();
        if (block.timestamp >= record.hold.expirationTimestamp) revert HoldExpirationReached();
        if (msg.sender != record.hold.escrow) revert IsNotEscrow();
        if (amount > record.hold.amount) revert InsufficientHoldBalance(record.hold.amount, amount);

        _restoreAllowance(idf, amount);

        record.hold.amount -= amount;
        heldBalance[idf.tokenHolder] -= amount;
        if (record.hold.amount == 0) _removeHold(idf);

        emit Transfer(address(0), idf.tokenHolder, amount);
        emit HoldByPartitionReleased(idf.tokenHolder, idf.partition, idf.holdId, amount);
        return true;
    }

    /// @notice Returns an EXPIRED hold in full to the holder, restoring the third party's allowance.
    /// @dev After expiry only, and callable by ANYONE — ATS puts no caller restriction on reclaim, so the
    ///      seller reclaims directly on the token once a listing lapses.
    ///      Revert precedence: {IsPaused} → {WrongHoldId} → {HoldExpirationNotReached}.
    /// @param idf The (partition, tokenHolder, holdId) triple.
    /// @return success_ Always true; reverts otherwise.
    function reclaimHoldByPartition(HoldIdentifier calldata idf) external returns (bool success_) {
        if (paused) revert IsPaused();
        HoldData storage record = _holds[idf.partition][idf.tokenHolder][idf.holdId];
        if (record.id == 0) revert WrongHoldId();
        if (block.timestamp < record.hold.expirationTimestamp) revert HoldExpirationNotReached();

        uint256 amount = record.hold.amount;
        _restoreAllowance(idf, amount);

        heldBalance[idf.tokenHolder] -= amount;
        _removeHold(idf);

        emit Transfer(address(0), idf.tokenHolder, amount);
        emit HoldByPartitionReclaimed(msg.sender, idf.tokenHolder, idf.partition, idf.holdId, amount);
        return true;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                   READS
    //////////////////////////////////////////////////////////////////////////*//

    /// @notice The balance `account` can move freely: `balanceOf - heldBalance`.
    /// @param account The account to read.
    /// @return balance_ The transferable balance.
    function transferableBalanceOf(address account) external view returns (uint256 balance_) {
        return balanceOf[account] - heldBalance[account];
    }

    /// @notice Reads one hold. Returns zeroes for a hold that never existed or has been drained.
    /// @dev `amount_` is the hold's OUTSTANDING amount — the value invariant 2 compares against a listing's
    ///      `remaining`. The 7-tuple matches ATS's own return shape exactly.
    /// @param idf The (partition, tokenHolder, holdId) triple.
    /// @return amount_ Tokens still held.
    /// @return expirationTimestamp_ When the hold expires; execution is barred from this second on.
    /// @return escrow_ The only address that may execute or release the hold.
    /// @return destination_ The pinned recipient, or the zero address when the escrow may choose.
    /// @return data_ The creator's payload — Tenor encodes the listing id here.
    /// @return operatorData_ The operator payload passed at creation.
    /// @return thirdPartyType_ `AUTHORIZED` for every hold this mock creates, which is what makes the
    ///         allowance restoration fire.
    function getHoldForByPartition(HoldIdentifier calldata idf)
        external
        view
        returns (
            uint256 amount_,
            uint256 expirationTimestamp_,
            address escrow_,
            address destination_,
            bytes memory data_,
            bytes memory operatorData_,
            ThirdPartyType thirdPartyType_
        )
    {
        HoldData storage record = _holds[idf.partition][idf.tokenHolder][idf.holdId];
        return (
            record.hold.amount,
            record.hold.expirationTimestamp,
            record.hold.escrow,
            record.hold.to,
            record.hold.data,
            record.operatorData,
            record.thirdPartyType
        );
    }

    /// @notice Total tokens `tokenHolder` has under hold on `partition`.
    /// @dev Summed from the live records rather than cached, so it can never drift from them.
    /// @param partition The partition to inspect.
    /// @param tokenHolder The holder to inspect.
    /// @return amount_ The held total.
    function getHeldAmountForByPartition(bytes32 partition, address tokenHolder)
        external
        view
        returns (uint256 amount_)
    {
        uint256 last = lastHoldId[partition][tokenHolder];
        for (uint256 id = 1; id <= last; ++id) {
            amount_ += _holds[partition][tokenHolder][id].hold.amount;
        }
    }

    /// @notice How many live holds `tokenHolder` has on `partition`.
    /// @param partition The partition to inspect.
    /// @param tokenHolder The holder to inspect.
    /// @return holdCount_ The number of holds that still exist.
    function getHoldCountForByPartition(bytes32 partition, address tokenHolder)
        external
        view
        returns (uint256 holdCount_)
    {
        uint256 last = lastHoldId[partition][tokenHolder];
        for (uint256 id = 1; id <= last; ++id) {
            if (_holds[partition][tokenHolder][id].id != 0) ++holdCount_;
        }
    }

    /// @notice One page of `tokenHolder`'s live hold ids on `partition`, in ascending id order.
    /// @dev Drained holds are skipped, so the ids are not contiguous. A short page means the end of the set.
    /// @param partition The partition to inspect.
    /// @param tokenHolder The holder to inspect.
    /// @param pageIndex Zero-based page number.
    /// @param pageLength Page size.
    /// @return holdsId_ The ids on that page.
    function getHoldsIdForByPartition(bytes32 partition, address tokenHolder, uint256 pageIndex, uint256 pageLength)
        external
        view
        returns (uint256[] memory holdsId_)
    {
        uint256 last = lastHoldId[partition][tokenHolder];
        uint256 skip = pageIndex * pageLength;
        uint256 seen;
        uint256 written;
        holdsId_ = new uint256[](pageLength);
        for (uint256 id = 1; id <= last; ++id) {
            if (_holds[partition][tokenHolder][id].id == 0) continue;
            if (seen++ < skip) continue;
            if (written == pageLength) break;
            holdsId_[written++] = id;
        }
        if (written == pageLength) return holdsId_;
        uint256[] memory page = new uint256[](written);
        for (uint256 i; i < written; ++i) {
            page[i] = holdsId_[i];
        }
        return page;
    }

    //*//////////////////////////////////////////////////////////////////////////
    //                                 INTERNALS
    //////////////////////////////////////////////////////////////////////////*//

    /// @dev Moves `amount` from `from`'s transferable balance to `to`. Pause, zero address and transferable
    ///      balance only — the contract-level notes say why KYC and the control list are not checked here.
    ///      This mock models no partition structure of its own, so {InsufficientBalance} reports the zero
    ///      partition here; the hold paths report whatever partition the call named.
    /// @param from The sender.
    /// @param to The recipient.
    /// @param amount The amount to move.
    function _transfer(address from, address to, uint256 amount) private {
        if (paused) revert IsPaused();
        if (to == address(0)) revert ZeroAddressNotAllowed();
        uint256 transferable = balanceOf[from] - heldBalance[from];
        if (transferable < amount) revert InsufficientBalance(from, transferable, amount, bytes32(0));
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    /// @dev Gives `amount` of allowance back to the hold's recorded third party, for `AUTHORIZED` holds only —
    ///      exactly ATS's `_restoreHoldAllowance`. MUST run before {_removeHold}, which clears the record.
    /// @param idf The (partition, tokenHolder, holdId) triple.
    /// @param amount The allowance to give back.
    function _restoreAllowance(HoldIdentifier calldata idf, uint256 amount) private {
        if (_holds[idf.partition][idf.tokenHolder][idf.holdId].thirdPartyType != ThirdPartyType.AUTHORIZED) return;
        address thirdParty = holdThirdParty[idf.partition][idf.tokenHolder][idf.holdId];
        uint256 restored = allowance[idf.tokenHolder][thirdParty] + amount;
        allowance[idf.tokenHolder][thirdParty] = restored;
        emit Approval(idf.tokenHolder, thirdParty, restored);
    }

    /// @dev Deletes a drained hold and its third-party attribution, so the identifier now reverts
    ///      {WrongHoldId} and {getHoldForByPartition} reads back zeroes. The id counter is untouched.
    /// @param idf The (partition, tokenHolder, holdId) triple.
    function _removeHold(HoldIdentifier calldata idf) private {
        delete _holds[idf.partition][idf.tokenHolder][idf.holdId];
        delete holdThirdParty[idf.partition][idf.tokenHolder][idf.holdId];
    }
}
