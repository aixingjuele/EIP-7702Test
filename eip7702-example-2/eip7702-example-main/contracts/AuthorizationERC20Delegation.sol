// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title AuthorizationERC20Delegation
/// @notice Minimal ERC20 token supporting EIP-3009 style transferWithAuthorization, designed
///         to be callable inside an EIP-7702 delegated code transaction (e.g. via BatchCallDelegation).
/// @dev This contract avoids external library dependencies for portability in the example project.
contract AuthorizationERC20Delegation {
    // --- ERC20 storage ---
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // --- Authorization (EIP-3009) ---
    enum AuthorizationState { Unused, Used, Canceled }
    mapping(bytes32 => AuthorizationState) public authorizationState; // key = keccak256(authorizer, nonce)

    // --- EIP712 Typehashes ---
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 public DOMAIN_SEPARATOR;

    // --- Events ---
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _initialSupply) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        uint256 chainId;
        assembly { chainId := chainid() }
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(_name)),
                keccak256(bytes("1")),
                chainId,
                address(this)
            )
        );
        _mint(msg.sender, _initialSupply);
    }

    // --- ERC20 core ---
    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "BALANCE");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "ALLOWANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    // --- Authorization helpers ---
    function _authKey(address authorizer, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(authorizer, nonce));
    }

    function _toTypedMessageHash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // --- transferWithAuthorization ---
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _validateAndUse(from, validAfter, validBefore, nonce, keccak256(abi.encode(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce
        )), v, r, s);
        _transfer(from, to, value);
    }

    // --- cancelAuthorization ---
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        bytes32 digest = _toTypedMessageHash(structHash);
        address recovered = ecrecover(digest, v, r, s);
        require(recovered == authorizer, "SIG");
        bytes32 key = _authKey(authorizer, nonce);
        AuthorizationState state = authorizationState[key];
        require(state == AuthorizationState.Unused, "STATE");
        authorizationState[key] = AuthorizationState.Canceled;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    // --- internal validation ---
    function _validateAndUse(
        address authorizer,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes32 structHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        require(block.timestamp > validAfter, "TIME_NOT_YET");
        require(block.timestamp < validBefore, "TIME_EXPIRED");
        bytes32 digest = _toTypedMessageHash(structHash);
        address recovered = ecrecover(digest, v, r, s);
        require(recovered == authorizer, "SIG");
        bytes32 key = _authKey(authorizer, nonce);
        require(authorizationState[key] == AuthorizationState.Unused, "USED_OR_CANCELLED");
        authorizationState[key] = AuthorizationState.Used;
        emit AuthorizationUsed(authorizer, nonce);
    }

    // --- View helpers for off-chain tooling ---
    function computeTransferWithAuthorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce
        ));
        return _toTypedMessageHash(structHash);
    }

    function computeCancelAuthorizationDigest(address authorizer, bytes32 nonce) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        return _toTypedMessageHash(structHash);
    }
}
