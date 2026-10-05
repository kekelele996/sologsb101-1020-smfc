/**
 * 外借展览 slice（Redux Toolkit）
 * 维护外馆点交单与展期状况记录。
 *
 * 两侧隔离原则：
 * - 收下点交单时，外馆原始记录（items 的收藏号 / 展柜号 / 拓法记录）落库一次即固化；
 * - 对账只写本馆拓本的借出标记（loanState / loanManifestId / loanCaseNo），拓法照旧不动；
 * - 本侧某条写库失败，只把该条目标记 localRetryPending，后续仅重试这几条本侧写入，
 *   外馆那份点交单记录绝不重写、不覆盖。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db } from '@/utils/db';
import type { LoanManifest, LoanManifestItem } from '@/types/loan';
import type { LoanCondition, LoanConditionDraft } from '@/types/loanCondition';
import {
  claimManifestItem,
  latestConditions,
  markLocalWriteFailure,
  markLocalWriteSuccess,
  parseManifestText,
  reconcileManifest,
  selectRetryableItems,
} from '@/utils/loan';
import type { RootState } from './store';

export interface CreateManifestInput {
  venue: string;
  exhibition: string;
  handoverDate: string;
  startDate: string;
  endDate: string;
  rawText: string;
}

export interface LoanStateShape {
  manifests: LoanManifest[];
  conditions: LoanCondition[];
  loading: boolean;
  ready: boolean;
  error: string;
  currentManifestId: string | null;
}

const initialState: LoanStateShape = {
  manifests: [],
  conditions: [],
  loading: false,
  ready: false,
  error: '',
  currentManifestId: null,
};

export const loadLoans = createAsyncThunk('loan/load', async () => {
  const [manifests, conditions] = await Promise.all([db.loanManifests.toArray(), db.loanConditions.toArray()]);
  manifests.sort((a, b) => b.updatedAt - a.updatedAt);
  return { manifests, conditions };
});

/**
 * 把本馆借出标记写到拓本表（本侧写入）。逐条独立写，单条失败只标记该条目本侧重试，
 * 不影响其它条目，也不回滚 / 改写外馆点交单原始记录。
 */
async function applyLocalLoanMarks(manifest: LoanManifest): Promise<LoanManifestItem[]> {
  const now = Date.now();
  const outcomes: LoanManifestItem[] = [];
  for (const item of manifest.items) {
    if (item.matchState !== 'matched' || !item.rubbingId) {
      outcomes.push(item);
      continue;
    }
    try {
      // 只挂借出标记；拓法 method 等编目字段一字不动（拓法照旧）
      const updated = await db.rubbings.update(item.rubbingId, {
        loanState: 'onLoan',
        loanManifestId: manifest.id,
        loanCaseNo: item.caseNo || null,
        updatedAt: now,
      } as never);
      // update 命中 0 行（拓本不存在等）也视为本侧失败，挂起重试
      if (updated === 0) throw new Error('本馆拓本不存在或未更新');
      outcomes.push(markLocalWriteSuccess(item));
    } catch (error) {
      outcomes.push(markLocalWriteFailure(item, error instanceof Error ? error.message : '本侧写库失败'));
    }
  }
  return outcomes;
}

/**
 * 收下点交单：解析外馆文本 → 收藏号 / 展柜号对账 → 外馆记录固化落库 →
 * 逐条写本馆借出标记（本侧失败只标记本侧重试）。
 */
export const receiveManifest = createAsyncThunk(
  'loan/receiveManifest',
  async (input: CreateManifestInput, { dispatch, getState }) => {
    const state = getState() as RootState;
    const rubbings = state.rubbing.items;

    const { lines } = parseManifestText(input.rawText);
    const items = reconcileManifest(lines, rubbings);

    const now = Date.now();
    // 外馆那份先落库并固化（本侧字段此时都为初始值）
    const manifest: LoanManifest = {
      id: createId('loan'),
      venue: input.venue,
      exhibition: input.exhibition,
      handoverDate: input.handoverDate,
      startDate: input.startDate,
      endDate: input.endDate,
      items,
      rawText: input.rawText,
      createdAt: now,
      updatedAt: now,
    };
    await db.loanManifests.put(manifest);

    // 再逐条写本馆借出标记，失败只标记本侧重试
    const settledItems = await applyLocalLoanMarks(manifest);
    const settled: LoanManifest = { ...manifest, items: settledItems, updatedAt: Date.now() };
    await db.loanManifests.put(settled);

    await dispatch(loadLoans());
    return { id: settled.id, retryCount: selectRetryableItems(settledItems).length };
  },
);

/** 仅重试本侧写库失败的条目；外馆点交单原始字段不动。 */
export const retryLocalWrites = createAsyncThunk(
  'loan/retryLocalWrites',
  async (manifestId: string, { dispatch }) => {
    const manifest = await db.loanManifests.get(manifestId);
    if (!manifest) return { id: manifestId, retryCount: 0 };
    const retried = await applyLocalLoanMarks(manifest);
    await db.loanManifests.put({ ...manifest, items: retried, updatedAt: Date.now() });
    await dispatch(loadLoans());
    return { id: manifestId, retryCount: selectRetryableItems(retried).length };
  },
);

/** 人工把待认领条目认到某拓本（凭展柜号核对）；随后只对这一条写本侧借出标记。 */
export const claimLoanItem = createAsyncThunk(
  'loan/claim',
  async (payload: { manifestId: string; lineNo: number; rubbingId: string }, { dispatch }) => {
    const manifest = await db.loanManifests.get(payload.manifestId);
    if (!manifest) return;
    const targetLineNo = payload.lineNo;
    const claimed = claimManifestItem(
      manifest.items.find((item) => item.lineNo === targetLineNo)!,
      payload.rubbingId,
    );
    // 同一拓本若已被其它条目占用，先把那条退回待认领（避免一件挂两柜）
    const items = manifest.items.map((item) => {
      if (item.lineNo === targetLineNo) return claimed;
      if (item.matchState === 'matched' && item.rubbingId === payload.rubbingId) {
        return { ...item, matchState: 'unclaimed' as const, rubbingId: null, localWriteError: '', localRetryPending: false };
      }
      return item;
    });
    const next: LoanManifest = { ...manifest, items, updatedAt: Date.now() };
    await db.loanManifests.put(next);
    const single = next.items.find((item) => item.lineNo === payload.lineNo);
    if (single) {
      const [settled] = await applyLocalLoanMarks({ ...next, items: [single] });
      if (settled) {
        const merged = next.items.map((item) => (item.lineNo === settled.lineNo ? settled : item));
        await db.loanManifests.put({ ...next, items: merged });
      }
    }
    await dispatch(loadLoans());
  },
);

/** 撤回认领（条目退回待认领，同时把拓本借出标记收回本馆） */
export const unclaimLoanItem = createAsyncThunk(
  'loan/unclaim',
  async (payload: { manifestId: string; lineNo: number }, { dispatch }) => {
    const manifest = await db.loanManifests.get(payload.manifestId);
    if (!manifest) return;
    const target = manifest.items.find((item) => item.lineNo === payload.lineNo);
    const rubbingId = target?.rubbingId ?? null;
    const items = manifest.items.map((item) =>
      item.lineNo === payload.lineNo
        ? { ...item, matchState: 'unclaimed' as const, rubbingId: null, localWriteError: '', localRetryPending: false }
        : item,
    );
    await db.loanManifests.put({ ...manifest, items, updatedAt: Date.now() });
    if (rubbingId) {
      await db.rubbings.update(rubbingId, {
        loanState: 'inHouse',
        loanManifestId: null,
        loanCaseNo: null,
        updatedAt: Date.now(),
      } as never);
    }
    await dispatch(loadLoans());
  },
);

/**
 * 接收外馆状况记录。同一件（点交单行）以晚到的为准：历史记录保留不删，
 * 读取侧用 latestConditions 取 receivedAt 最大的一条。新损伤只在借展侧（本表）。
 */
export const receiveCondition = createAsyncThunk(
  'loan/receiveCondition',
  async (draft: LoanConditionDraft, { dispatch }) => {
    const now = Date.now();
    const row: LoanCondition = {
      ...draft,
      id: createId('lc'),
      createdAt: now,
      updatedAt: now,
    };
    await db.loanConditions.put(row);
    await dispatch(loadLoans());
    return row;
  },
);

export const removeManifest = createAsyncThunk('loan/removeManifest', async (id: string, { dispatch }) => {
  // 删点交单时收回其在借拓本的本馆标记；外馆状况记录随单删除
  const manifest = await db.loanManifests.get(id);
  const rubbingIds = new Set((manifest?.items ?? []).map((item) => item.rubbingId).filter((value): value is string => !!value));
  await db.transaction('rw', [db.loanManifests, db.loanConditions, db.rubbings], async () => {
    await db.loanConditions.where('manifestId').equals(id).delete();
    await db.loanManifests.delete(id);
    const now = Date.now();
    for (const rubbingId of rubbingIds) {
      await db.rubbings.update(rubbingId, {
        loanState: 'inHouse',
        loanManifestId: null,
        loanCaseNo: null,
        updatedAt: now,
      } as never);
    }
  });
  await dispatch(loadLoans());
});

const loanSlice = createSlice({
  name: 'loan',
  initialState,
  reducers: {
    setCurrentManifest(state, action: PayloadAction<string | null>) {
      state.currentManifestId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadLoans.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadLoans.fulfilled, (state, action) => {
        state.manifests = action.payload.manifests;
        state.conditions = action.payload.conditions;
        state.loading = false;
        state.ready = true;
        state.error = '';
        const exists =
          state.currentManifestId !== null && action.payload.manifests.some((row) => row.id === state.currentManifestId);
        if (!exists) state.currentManifestId = action.payload.manifests[0]?.id ?? null;
      })
      .addCase(loadLoans.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '借展数据读取失败';
      });
  },
});

export const { setCurrentManifest } = loanSlice.actions;

export const selectLoanState = (state: RootState): LoanStateShape => state.loan;
export const selectManifests = (state: RootState): LoanManifest[] => state.loan.manifests;
export const selectConditions = (state: RootState): LoanCondition[] => state.loan.conditions;
export const selectCurrentManifestId = (state: RootState): string | null => state.loan.currentManifestId;

/** 每件（点交单行）晚到为准的状况记录 */
export const selectLatestConditions = (state: RootState): LoanCondition[] => latestConditions(state.loan.conditions);

export default loanSlice.reducer;
