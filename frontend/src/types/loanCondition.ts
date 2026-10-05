/**
 * 外馆状况记录（LoanCondition）数据模型
 * 展期内外馆发来的状况巡查；同一件（点交单条目）以晚到的为准。
 * 新损伤只登记在借展侧（本表），不并入本馆 losses 损泐表。
 */
import type { LossSeverity, LossType } from './loss';

export interface LoanCondition {
  id: string;
  /** 所属点交单 id */
  manifestId: string;
  /** 对应点交单内的行号 */
  lineNo: string;
  /** 外馆记录日期 yyyy-MM-dd（晚到 = receivedAt 更晚） */
  reportedOn: string;
  /** 到达编目台的时间戳，用于「以晚到为准」的覆盖判定 */
  receivedAt: number;
  /** 状况摘要（如「纸本完好」「边角轻损」） */
  summary: string;
  /** 是否报告了新损伤 */
  hasNewDamage: boolean;
  /** 新损伤类型（仅借展侧记录，不进本馆 losses） */
  damageType: LossType | null;
  /** 新损伤严重程度 */
  damageSeverity: LossSeverity | null;
  /** 新损伤字位坐标（行号），无法定位时为 null */
  damageLineNo: number | null;
  /** 新损伤字位坐标（行内字位），无法定位时为 null */
  damageCharNo: number | null;
  /** 外馆备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type LoanConditionDraft = Omit<LoanCondition, 'id' | 'createdAt' | 'updatedAt'>;
