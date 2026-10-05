/**
 * /loans 借展管理
 * 收下外馆点交单（先收藏号再展柜号），按藏号对账：对上的挂借出标记（拓法照旧），
 * 认不上的挂待认领；展期状况记录以晚到的为准，新损伤只记借展侧；
 * 本馆写库失败只重试本侧几条，外馆点交单快照不动。
 * 消费 Loan、Rubbing、Stele；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FileAddOutlined, FormOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  claimLoan,
  receiveConditionReport,
  receiveHandoverList,
  removeLoan,
  resetLoanFilters,
  retryFailedLocal,
  selectFailedLocal,
  selectFilteredLoans,
  selectLastBatch,
  selectLoanStats,
  selectLoans,
  setLoanKeyword,
  setLoanStates,
} from '@/stores/loanSlice';
import { LOAN_STATE_COLOR, LOAN_STATE_LABEL, LOAN_STATE_OPTIONS, type Loan } from '@/types/loan';
import { RUBBING_METHOD_LABEL, type Rubbing } from '@/types/rubbing';
import { latestReport, matchRubbingByCollectionNo, parseHandoverText } from '@/utils/loan';

const FILTER_KEYS = ['state'] as const;

export default function LoanBoard() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [handoverForm] = Form.useForm<{ venue: string; handoverDate: string }>();
  const [reportForm] = Form.useForm<{ reportDate: string; condition: string; newDamage: string }>();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const loans = useAppSelector(selectLoans);
  const filtered = useAppSelector(selectFilteredLoans);
  const stats = useAppSelector(selectLoanStats);
  const failedLocal = useAppSelector(selectFailedLocal);
  const lastBatch = useAppSelector(selectLastBatch);

  const url = useFilterQuery(FILTER_KEYS);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverText, setHandoverText] = useState('');
  const [reportLoan, setReportLoan] = useState<Loan | null>(null);
  const [claimLoanTarget, setClaimLoanTarget] = useState<Loan | null>(null);
  const [claimRubbingId, setClaimRubbingId] = useState<string | null>(null);

  useEffect(() => {
    dispatch(setLoanKeyword(url.keyword));
    dispatch(setLoanStates((url.values.state ?? []) as Array<Loan['state']>));
  }, [dispatch, url.keyword, url.values]);

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'state', label: '借展状态', options: LOAN_STATE_OPTIONS.map((item) => ({ value: item.value, label: item.label })) },
    ],
    [],
  );

  const steleTitle = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? steleId;

  const rubbingLabel = (rubbing: Rubbing): string =>
    `第 ${rubbing.versionNo} 版 · ${steleTitle(rubbing.steleId)}（${rubbing.collectionNo || '未编'}）`;

  /** 点交单实时解析预览（先收藏号再展柜号） */
  const parsed = useMemo(() => parseHandoverText(handoverText), [handoverText]);

  const openHandover = (): void => {
    handoverForm.setFieldsValue({
      venue: lastBatch?.venue ?? '',
      handoverDate: new Date().toISOString().slice(0, 10),
    });
    setHandoverText('');
    setHandoverOpen(true);
  };

  const submitHandover = async (): Promise<void> => {
    const values = await handoverForm.validateFields();
    if (parsed.entries.length === 0) {
      message.warning('点交单没有可识别的条目，请按「藏号 展柜号」每行一条填写');
      return;
    }
    const result = await dispatch(
      receiveHandoverList({ venue: values.venue, handoverDate: values.handoverDate, entries: parsed.entries }),
    ).unwrap();
    const matched = result.batch.entries.filter((entry) => entry.rubbingId !== null).length;
    const pending = result.batch.entries.length - matched;
    message.success(
      `点交单已收下：对上 ${matched} 件已挂借出标记，待认领 ${pending} 件` +
        (result.failed.length > 0 ? `，本侧 ${result.failed.length} 条写库失败待重试` : ''),
    );
    setHandoverOpen(false);
  };

  const openReport = (loan: Loan): void => {
    setReportLoan(loan);
    reportForm.setFieldsValue({
      reportDate: new Date().toISOString().slice(0, 10),
      condition: '',
      newDamage: '',
    });
  };

  const submitReport = async (): Promise<void> => {
    if (!reportLoan) return;
    const values = await reportForm.validateFields();
    await dispatch(
      receiveConditionReport({
        loanId: reportLoan.id,
        reportDate: values.reportDate,
        condition: values.condition,
        newDamage: values.newDamage ?? '',
      }),
    ).unwrap();
    message.success('状况记录已登记（同一件以晚到的为准，新损伤只记借展侧）');
    setReportLoan(null);
  };

  const submitClaim = async (): Promise<void> => {
    if (!claimLoanTarget || !claimRubbingId) return;
    await dispatch(claimLoan({ loanId: claimLoanTarget.id, rubbingId: claimRubbingId })).unwrap();
    message.success('已认领并挂借出标记');
    setClaimLoanTarget(null);
    setClaimRubbingId(null);
  };

  const columns: ColumnsType<Loan> = [
    { title: '藏号', dataIndex: 'collectionNo', width: 110 },
    { title: '展柜号', dataIndex: 'caseNo', width: 90, render: (value: string) => value || '—' },
    { title: '外馆', dataIndex: 'venue', width: 130 },
    { title: '点交日期', dataIndex: 'handoverDate', width: 110 },
    {
      title: '对应拓本',
      dataIndex: 'rubbingId',
      width: 200,
      render: (value: string | null) => {
        if (value === null) return <Tag color={LOAN_STATE_COLOR.pendingClaim}>待认领</Tag>;
        const rubbing = rubbings.find((item) => item.id === value);
        return rubbing ? (
          <Space size={4} wrap>
            <span>{rubbingLabel(rubbing)}</span>
            <Tag>{RUBBING_METHOD_LABEL[rubbing.method]}</Tag>
          </Space>
        ) : (
          '拓本已删除'
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 90,
      render: (value: Loan['state']) => <Tag color={LOAN_STATE_COLOR[value]}>{LOAN_STATE_LABEL[value]}</Tag>,
    },
    {
      title: '最新状况（晚到为准）',
      key: 'latest',
      render: (_value, record) => {
        const latest = latestReport(record);
        if (!latest) return <Typography.Text type="secondary">暂无状况记录</Typography.Text>;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>{latest.condition}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {latest.reportDate} 来文 · 本馆 {new Date(latest.receivedAt).toLocaleString('zh-CN')} 收到
              {record.reports.length > 1 ? ` · 共 ${record.reports.length} 份` : ''}
            </Typography.Text>
            {latest.newDamage ? (
              <Typography.Text style={{ fontSize: 12, color: LOAN_STATE_COLOR.onLoan }}>
                新损伤：{latest.newDamage}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<FormOutlined />} onClick={() => openReport(record)}>
            状况登记
          </Button>
          {record.state === 'pendingClaim' ? (
            <Button
              size="small"
              type="link"
              icon={<LinkOutlined />}
              onClick={() => {
                setClaimLoanTarget(record);
                setClaimRubbingId(null);
              }}
            >
              认领
            </Button>
          ) : null}
          <Popconfirm
            title="销记该借展记录"
            description="对应拓本的借出标记将一并解除。"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void dispatch(removeLoan(record.id))
                .unwrap()
                .then(() => message.success('已销记'))
            }
          >
            <Button size="small" type="link" danger>
              销记
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const reportHistory = reportLoan
    ? [...reportLoan.reports].sort((a, b) => b.receivedAt - a.receivedAt)
    : [];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>借展管理</h2>
          <p>收下外馆点交单（先收藏号再展柜号），对上的挂借出标记、认不上的挂待认领；展期状况以晚到的为准。</p>
        </div>
        <Space wrap>
          <Button type="primary" icon={<FileAddOutlined />} onClick={openHandover}>
            收下点交单
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="借出中" value={stats.onLoan} suffix="件" tone="danger" />
        <StatBadge label="待认领" value={stats.pendingClaim} suffix="件" tone="warning" />
        <StatBadge label="状况记录" value={stats.reports} suffix="份" tone="info" />
        <StatBadge label="本侧待重试" value={failedLocal.length} suffix="条" />
      </div>

      {failedLocal.length > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message={`本馆写库失败 ${failedLocal.length} 条，外馆点交单那份保持不动`}
          description={
            <Space direction="vertical" size={4}>
              <span>待重试藏号：{failedLocal.map((entry) => entry.collectionNo).join('、')}</span>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() =>
                  void dispatch(retryFailedLocal())
                    .unwrap()
                    .then((result) =>
                      message.success(
                        result.failed.length === 0
                          ? '本侧失败条目已全部补写完成'
                          : `仍有 ${result.failed.length} 条写库失败，可再次重试`,
                      ),
                    )
                }
              >
                只重试本侧这几条
              </Button>
            </Space>
          }
        />
      ) : null}

      {lastBatch ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          最近收下的点交单：{lastBatch.venue || '外馆未具名'} · {lastBatch.handoverDate} · 共 {lastBatch.entries.length} 条 ·
          本馆 {new Date(lastBatch.receivedAt).toLocaleString('zh-CN')} 收下
        </Typography.Text>
      ) : null}

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={selects}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          dispatch(resetLoanFilters());
        }}
        keywordPlaceholder="搜索藏号 / 展柜号 / 外馆…"
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={loans.length === 0 ? '还没有借展记录' : '当前筛选条件下没有借展记录'}
            description={
              loans.length === 0
                ? '收下外馆发来的点交单，按藏号对账后自动挂借出标记；认不上的先挂待认领。'
                : '试着调整借展状态筛选条件。'
            }
            actionText="收下点交单"
            onAction={openHandover}
            secondaryText="重置筛选"
            onSecondary={() => url.reset()}
            size="small"
          />
        ) : (
          <Table<Loan> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={filtered} />
        )}
      </Card>

      {/* 收下点交单 */}
      <Modal
        open={handoverOpen}
        title="收下点交单"
        onCancel={() => setHandoverOpen(false)}
        onOk={() => void submitHandover()}
        okText="收下并对账"
        cancelText="取消"
        width={640}
        destroyOnClose
      >
        <Form form={handoverForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="venue" label="借展外馆" rules={[{ required: true, message: '请填写外馆名称' }]} style={{ flex: 1 }}>
              <Input placeholder="如：江南图书馆" />
            </Form.Item>
            <Form.Item name="handoverDate" label="点交日期" rules={[{ required: true, message: '请填写点交日期' }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          每行一条「藏号 展柜号」（逗号、顿号或空格分隔均可），收下后按先收藏号再展柜号排序对账；
          对上的只挂借出标记，编目员填的拓法照旧。
        </Typography.Text>
        <Input.TextArea
          style={{ marginTop: 8 }}
          rows={6}
          placeholder={'藏号,展柜号\nTB-0101,A-01\nTB-0201,A-02'}
          value={handoverText}
          onChange={(event) => setHandoverText(event.target.value)}
        />
        {handoverText.trim().length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <Typography.Text style={{ fontSize: 12 }}>
              识别 {parsed.entries.length} 条（已按先收藏号再展柜号排序）
              {parsed.skipped.length > 0 ? `，跳过无法识别 ${parsed.skipped.length} 行` : ''}
            </Typography.Text>
            {parsed.entries.length > 0 ? (
              <Table
                rowKey={(row) => `${row.collectionNo}|${row.caseNo}`}
                size="small"
                style={{ marginTop: 6 }}
                pagination={false}
                scroll={{ y: 180 }}
                dataSource={parsed.entries}
                columns={[
                  { title: '藏号', dataIndex: 'collectionNo', width: 120 },
                  { title: '展柜号', dataIndex: 'caseNo', width: 90, render: (value: string) => value || '—' },
                  {
                    title: '对账结果',
                    key: 'match',
                    render: (_value, record) => {
                      const rubbing = matchRubbingByCollectionNo(rubbings, record.collectionNo);
                      return rubbing ? (
                        <Tag color="#2f6f4f">{rubbingLabel(rubbing)}</Tag>
                      ) : (
                        <Tag color={LOAN_STATE_COLOR.pendingClaim}>待认领</Tag>
                      );
                    },
                  },
                ]}
              />
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* 状况记录登记 */}
      <Modal
        open={reportLoan !== null}
        title={`状况记录 · ${reportLoan?.collectionNo ?? ''}（${reportLoan?.venue ?? ''}）`}
        onCancel={() => setReportLoan(null)}
        onOk={() => void submitReport()}
        okText="登记状况"
        cancelText="取消"
        width={560}
        destroyOnClose
      >
        {reportHistory.length > 0 ? (
          <div style={{ marginBottom: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已收到 {reportHistory.length} 份，同一件以晚到的为准：
            </Typography.Text>
            {reportHistory.map((report, index) => (
              <div key={report.id} style={{ fontSize: 12, marginTop: 4 }}>
                <Space size={6} wrap>
                  {index === 0 ? <Tag color="#2f6f4f">当前有效</Tag> : null}
                  <span>
                    {report.reportDate} 来文 · 本馆 {new Date(report.receivedAt).toLocaleString('zh-CN')} 收到：
                    {report.condition}
                  </span>
                  {report.newDamage ? <Tag color={LOAN_STATE_COLOR.onLoan}>新损伤：{report.newDamage}</Tag> : null}
                </Space>
              </div>
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
            该件暂无状况记录。
          </Typography.Text>
        )}
        <Form form={reportForm} layout="vertical" preserve={false}>
          <Form.Item name="reportDate" label="外馆来文日期" rules={[{ required: true, message: '请填写来文日期' }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="condition" label="状况描述" rules={[{ required: true, message: '请填写状况描述' }]}>
            <Input.TextArea rows={2} placeholder="如：展柜恒温恒湿，拓片平整" />
          </Form.Item>
          <Form.Item
            name="newDamage"
            label="新损伤（只记借展侧，不并入本馆损泐字位）"
            extra="归还点交前，此处内容不会写入本馆损泐标注台。"
          >
            <Input.TextArea rows={2} placeholder="如：下绫边起毛约 2 厘米" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 认领待认领条目 */}
      <Modal
        open={claimLoanTarget !== null}
        title={`认领 · 藏号 ${claimLoanTarget?.collectionNo ?? ''}`}
        onCancel={() => setClaimLoanTarget(null)}
        onOk={() => void submitClaim()}
        okText="认领并挂借出标记"
        cancelText="取消"
        destroyOnClose
      >
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          点交单上认不上的条目先挂待认领；在此指定本馆拓本后转为借出中，拓法等编目字段照旧。
        </Typography.Text>
        <Select
          style={{ width: '100%' }}
          placeholder="选择本馆拓本"
          value={claimRubbingId ?? undefined}
          options={rubbings
            .filter((rubbing) => rubbing.loanState !== 'onLoan')
            .map((rubbing) => ({ value: rubbing.id, label: rubbingLabel(rubbing) }))}
          onChange={(value: string) => setClaimRubbingId(value)}
        />
      </Modal>
    </div>
  );
}
