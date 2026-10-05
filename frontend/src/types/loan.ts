/**
 * 外借点交单（LoanManifest）数据模型
 * 点交单由外馆登记，编目台收下后按「收藏号 → 展柜号」顺序对账。
 * 本表保存外馆那份原始记录：本馆写库失败重试时不改动、不覆盖。
 */
import type { RubbingLoanState } from './rubbing';
import { RUBBING_LOAN_STATE_COLOR, RUBBING_LOAN_STATE_LABEL } from './rubbing';

/** 点交条目对账状态：已对上（借出）/ 待认领（认不上） */
export type LoanMatchState = 'matched' | 'unclaimed';

/** 借展状态沿用拓本模型：未借展 / 已借出（对上点交单）/ 待认领（外馆有、本馆认不上） */
export type LoanStatus = RubbingLoanState;

export interface LoanManifestItem {
  /** 外馆点交单行号（单内稳定，不随对账变化） */
  lineNo: number;
  /** 外馆登记的收藏号（第一件对账依据） */
  collectionNo: string;
  /** 展柜号（收藏号认不上时的第二件对账依据） */
  caseNo: string;
  /** 外馆登记的拓法，仅作外馆记录，不回写本馆拓本 */
  methodNote: string;
  /** 外馆登记的纸墨 / 尺寸等备注 */
  remark: string;
  /** 对账结果 */
  matchState: LoanMatchState;
  /** 对上的本馆拓本 id（认不上时为 null，保持待认领） */
  rubbingId: string | null;
  /** 本侧最近一次写库失败信息（空串表示本侧已落库或尚未写入） */
  localWriteError: string;
  /** 本侧待重试：写库失败后置 true，重试只重试本侧条目，不动外馆原始字段 */
  localRetryPending: boolean;
}

export interface LoanManifest {
  id: string;
  /** 外馆 / 展览名称 */
  venue: string;
  /** 展览名称 */
  exhibition: string;
  /** 点交日期 yyyy-MM-dd */
  handoverDate: string;
  /** 展期开始 yyyy-MM-dd */
  startDate: string;
  /** 展期结束 yyyy-MM-dd */
  endDate: string;
  /** 点交单条目（外馆那份，按行号排序） */
  items: LoanManifestItem[];
  /** 点交单原始文本（收下时留存，重试 / 再对账都基于结构化条目，不改原文） */
  rawText: string;
  createdAt: number;
  updatedAt: number;
}

export const LOAN_MATCH_STATE_LABEL: Record<LoanMatchState, string> = {
  matched: '已对上',
  unclaimed: '待认领',
};

/** 借展状态文案 / 颜色复用拓本模型定义 */
export const LOAN_STATUS_LABEL = RUBBING_LOAN_STATE_LABEL;
export const LOAN_STATUS_COLOR = RUBBING_LOAN_STATE_COLOR;
