/**
 * 邀请关系服务（对应 docs/COMMISSION-SYSTEM-SPEC.md 2.1 / Flow 1 / Flow 3）
 *
 * 铁律：邀请码非必填，无效邀请码绝不能阻断注册——
 * validateCode 只返回校验结果，绑定失败时调用方应照常完成注册。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { BillingLogger } from '../config.js';
import type {
  CommissionStorage,
  ReferralCodeRow,
  ReferralRelationshipRow,
} from './types.js';

/** 去除易混淆字符（0/O/1/I/L）后的码表 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
  }
  return code;
}

export interface ReferralServiceOptions {
  storage: CommissionStorage;
  inviteLinkTemplate?: string;
  logger?: BillingLogger;
  /** 生成码时的碰撞重试上限 */
  maxCollisionRetries?: number;
}

export interface ValidateCodeResult {
  valid: boolean;
  referrerUserId?: string;
  reason?: 'NOT_FOUND' | 'INACTIVE' | 'SELF_REFERRAL';
}

export interface BindResult {
  bound: boolean;
  relationshipId?: string;
  reason?: 'INVALID_CODE' | 'SELF_REFERRAL' | 'ALREADY_BOUND';
}

export class ReferralService {
  private storage: CommissionStorage;
  private inviteLinkTemplate?: string;
  private logger?: BillingLogger;
  private maxCollisionRetries: number;

  constructor(opts: ReferralServiceOptions) {
    this.storage = opts.storage;
    this.inviteLinkTemplate = opts.inviteLinkTemplate;
    this.logger = opts.logger;
    this.maxCollisionRetries = opts.maxCollisionRetries ?? 5;
  }

  buildInviteLink(code: string): string | null {
    if (!this.inviteLinkTemplate) return null;
    return this.inviteLinkTemplate.replace('{CODE}', code);
  }

  /** 获取或创建用户专属邀请码（幂等） */
  async getOrCreateCode(userId: string): Promise<ReferralCodeRow> {
    const existing = await this.storage.getReferralCodeByUserId(userId);
    if (existing) return existing;

    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxCollisionRetries; attempt++) {
      const code = generateCode();
      const clash = await this.storage.getReferralCodeByCode(code);
      if (clash) continue; // 碰撞，重试
      const row: ReferralCodeRow = {
        id: randomUUID(),
        code,
        userId,
        isActive: true,
        totalInvites: 0,
        convertedCount: 0,
        createdAt: new Date(),
      };
      await this.storage.insertReferralCode(row);
      return row;
    }
    throw lastError ?? new Error('commission: 邀请码生成失败（连续碰撞）');
  }

  /**
   * 校验邀请码。只读，不产生副作用。
   * @param code      用户输入的邀请码（可为空）
   * @param refereeUserId 被邀请人，用于自推检测
   */
  async validateCode(code: string | null | undefined, refereeUserId?: string): Promise<ValidateCodeResult> {
    if (!code) return { valid: false, reason: 'NOT_FOUND' };
    const normalized = code.trim().toUpperCase();
    const row = await this.storage.getReferralCodeByCode(normalized);
    if (!row) return { valid: false, reason: 'NOT_FOUND' };
    if (!row.isActive) return { valid: false, reason: 'INACTIVE' };
    if (refereeUserId && row.userId === refereeUserId) return { valid: false, reason: 'SELF_REFERRAL' };
    return { valid: true, referrerUserId: row.userId };
  }

  /**
   * 注册时绑定推荐关系（Flow 1）。
   * 铁律：绑定失败不抛错、不阻断注册，仅返回 bound=false + reason。
   */
  async bindReferee(
    refereeUserId: string,
    code: string | null | undefined,
    metadata?: Record<string, unknown>,
  ): Promise<BindResult> {
    // 邀请码非必填：空码直接视为未绑定，照常注册
    if (!code) return { bound: false, reason: 'INVALID_CODE' };

    const validation = await this.validateCode(code, refereeUserId);
    if (!validation.valid || !validation.referrerUserId) {
      this.logger?.info('commission.referral.bind_skipped', {
        refereeUserId,
        reason: validation.reason,
      });
      return { bound: false, reason: validation.reason === 'SELF_REFERRAL' ? 'SELF_REFERRAL' : 'INVALID_CODE' };
    }

    // 已存在生效关系则不重复绑定
    const existing = await this.storage.getActiveReferrer(refereeUserId);
    if (existing) return { bound: false, reason: 'ALREADY_BOUND' };

    const relationshipId = randomUUID();
    const row: ReferralRelationshipRow = {
      id: relationshipId,
      referrerUserId: validation.referrerUserId,
      refereeUserId,
      originalCode: code.trim().toUpperCase(),
      status: 'PENDING',
      createdAt: new Date(),
      activatedAt: null,
      metadata,
    };
    await this.storage.insertRelationship(row);
    await this.storage.incrementCodeStats(row.originalCode, 'totalInvites');
    this.logger?.info('commission.referral.bound', { refereeUserId, referrerUserId: validation.referrerUserId });
    return { bound: true, relationshipId };
  }

  /**
   * 更换推荐人（Flow 3）：旧关系置 EXPIRED，建立新 PENDING 关系。
   * 只影响未来订单，历史佣金归属永不改写（链快照固化）。
   */
  async changeReferrer(
    refereeUserId: string,
    newCode: string,
    metadata?: Record<string, unknown>,
  ): Promise<BindResult> {
    const validation = await this.validateCode(newCode, refereeUserId);
    if (!validation.valid || !validation.referrerUserId) {
      return { bound: false, reason: validation.reason === 'SELF_REFERRAL' ? 'SELF_REFERRAL' : 'INVALID_CODE' };
    }

    const existing = await this.storage.getActiveReferrer(refereeUserId);
    if (existing) {
      if (existing.referrerUserId === validation.referrerUserId) {
        return { bound: false, reason: 'ALREADY_BOUND' };
      }
      await this.storage.setRelationshipStatus(existing.id, 'EXPIRED');
    }

    const relationshipId = randomUUID();
    const row: ReferralRelationshipRow = {
      id: relationshipId,
      referrerUserId: validation.referrerUserId,
      refereeUserId,
      originalCode: newCode.trim().toUpperCase(),
      status: 'PENDING',
      createdAt: new Date(),
      activatedAt: null,
      metadata: { ...metadata, changedFrom: existing?.referrerUserId ?? null },
    };
    await this.storage.insertRelationship(row);
    await this.storage.incrementCodeStats(row.originalCode, 'totalInvites');
    this.logger?.info('commission.referral.changed', {
      refereeUserId,
      newReferrerUserId: validation.referrerUserId,
    });
    return { bound: true, relationshipId };
  }

  /** 首次付费后激活关系（PENDING → ACTIVE），供引擎在计佣成功后调用 */
  async activateRelationship(relationshipId: string, at: Date = new Date()): Promise<void> {
    await this.storage.setRelationshipStatus(relationshipId, 'ACTIVE', at);
  }
}
