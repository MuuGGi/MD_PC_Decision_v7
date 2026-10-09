'use strict';
class V7Error extends Error { constructor(code, message = code, details = {}) { super(message); this.name=this.constructor.name; this.code=code; this.details=details; } }
class ContractError extends V7Error {}
class NotReadyError extends V7Error {}
class UnknownFactError extends V7Error {}
class UnsafeReplayError extends V7Error {}
class CommitConflictError extends V7Error {}
class ShadowViolationError extends V7Error {}
class OwnershipError extends V7Error {}
module.exports={V7Error,ContractError,NotReadyError,UnknownFactError,UnsafeReplayError,CommitConflictError,ShadowViolationError,OwnershipError};
