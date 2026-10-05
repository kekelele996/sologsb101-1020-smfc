/**
 * /loans 外借展览对账台
 * 编目台收下外馆点交单：按「收藏号 → 展柜号」对账，对上的在本馆拓本挂借出标记（拓法照旧）；
 * 认不上的挂待认领，可凭展柜号人工认上。展期状况记录同一件以晚到为准，
 * 新损伤只记借展侧（不并入本馆损泐）。本侧写库失败只重试本侧几条，外馆那份不动。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  ExperimentOutlined,
  RetweetOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import LossTag from '@/components/common/LossTag';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  claimLoanItem,
  receiveCondition,
  receiveManifest,
  removeManifest,
  retryLocalWrites,
  selectConditions,
  selectCurrentManifestId,
  selectLatestConditions,
  selectManifests,
  setCurrentManifest,
  unclaimLoanItem,
} from '@/stores/loanSlice';
import { RUBBING_LOAN_STATE_COLOR, RUBBING_LOAN_STATE_LABEL, RUBBING_METHOD_LABEL } from '@/types/rubbing';
import { LOAN_MATCH_STATE_LABEL } from '@/types/loan';
import type { LoanManifestItem } from '@/types/loan';
import type { LoanConditionDraft } from '@/types/loanCondition';
import { LOSS_SEVERITY_OPTIONS, LOSS_TYPE_OPTIONS, type LossSeverity, type LossType } from '@/types/loss';
import { latestConditionFor, loanSideDamages, parseManifestText } from '@/utils/loan';

const { TextArea } = Input;

interface ManifestFormValues {
  venue: string;
  exhibition: string;
  handoverDate: Dayjs;
  startDate: Dayjs;
  endDate: Dayjs;
  rawText: string;
}

interface ConditionFormValues {
  reportedOn: Dayjs;
  summary: string;
  hasNewDamage: boolean;
  damageType?: LossType;
  damageSeverity?: LossSeverity;
  damageLineNo?: number;
  damageCharNo?: number;
  note?: string;
}

export default function LoanBoard() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const manifests = useAppSelector(selectManifests);
  const conditions = useAppSelector(selectConditions);
  const latestConditions = useAppSelector(selectLatestConditions);
  const currentId = useAppSelector(selectCurrentManifestId);

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [claimItem, setClaimItem] = useState<LoanManifestItem | null>(null);
  const [claimRubbingId, setClaimRubbingId] = useState<string | undefined>();
  const [conditionItem, setConditionItem] = useState<LoanManifestItem | null>(null);
  const [receiveForm] = Form.useForm<ManifestFormValues>();
  const [conditionForm] = Form.useForm<ConditionFormValues>();

  const manifest = manifests.find((row) => row.id === currentId) ?? manifests[0] ?? null;

  const stat = useMemo(() => {
    const onLoan = rubbings.filter((rubbing) => rubbing.loanState === 'onLoan').length;
    const unclaimed = manifests.reduce(
      (sum, row) => sum + row.items.filter((item) => item.matchState === 'unclaimed').length,
      0,
    );
    const retry = manifests.reduce((sum, row) => sum + row.items.filter((item) => item.localRetryPending).length, 0);
    return { manifests: manifests.length, onLoan, unclaimed, retry, damages: loanSideDamages(conditions).length };
  }, [conditions, manifests, rubbings]);

  const steleTitle = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? steleId;

  const openReceive = (): void => {
    receiveForm.resetFields();
    receiveForm.setFieldsValue({
      venue: '',
      exhibition: '',
      handoverDate: dayjs(),
      startDate: dayjs(),
      endDate: dayjs().add(30, 'day'),
      rawText: 'TB-0101，A-12，擦拓，备注\nTB-XXXX，B-03，扑拓，收藏号待核',
    });
    setReceiveOpen(true);
  };

  const submitReceive = async (): Promise<void> => {
    const values = await receiveForm.validateFields();
    const parsed = parseManifestText(values.rawText);
    if (parsed.lines.length === 0) {
      message.warning('点交单未解析出任何条目，请按「收藏号，展柜号，拓法，备注」每行一条填写');
      return;
    }
    const result = await dispatch(
      receiveManifest({
        venue: values.venue,
        exhibition: values.exhibition,
        handoverDate: values.handoverDate.format('YYYY-MM-DD'),
        startDate: values.startDate.format('YYYY-MM-DD'),
        endDate: values.endDate.format('YYYY-MM-DD'),
        rawText: values.rawText,
      }),
    ).unwrap();
    setReceiveOpen(false);
    message.success(
      `已收下点交单（${parsed.lines.length} 条，收藏号/展柜号对账完成）${
        result.retryCount > 0 ? `；${result.retryCount} 条本侧写库失败，待重试` : ''
      }`,
    );
  };

  const openClaim = (item: LoanManifestItem): void => {
    setClaimItem(item);
    setClaimRubbingId(undefined);
  };

  const submitClaim = async (): Promise<void> => {
    if (!manifest || !claimItem || !claimRubbingId) {
      message.warning('请选择要认上的本馆拓本');
      return;
    }
    await dispatch(
      claimLoanItem({ manifestId: manifest.id, lineNo: claimItem.lineNo, rubbingId: claimRubbingId }),
    ).unwrap();
    message.success('已认上并在本馆拓本挂借出标记（拓法照旧）');
    setClaimItem(null);
  };

  const openCondition = (item: LoanManifestItem): void => {
    setConditionItem(item);
    conditionForm.resetFields();
    conditionForm.setFieldsValue({
      reportedOn: dayjs(),
      summary: '',
      hasNewDamage: false,
      note: '',
    });
  };

  const submitCondition = async (): Promise<void> => {
    if (!manifest || !conditionItem) return;
    const values = await conditionForm.validateFields();
    const draft: LoanConditionDraft = {
      manifestId: manifest.id,
      lineNo: String(conditionItem.lineNo),
      reportedOn: values.reportedOn.format('YYYY-MM-DD'),
      receivedAt: Date.now(),
      summary: values.summary,
      hasNewDamage: !!values.hasNewDamage,
      damageType: values.hasNewDamage ? (values.damageType ?? null) : null,
      damageSeverity: values.hasNewDamage ? (values.damageSeverity ?? null) : null,
      damageLineNo: values.hasNewDamage ? (values.damageLineNo ?? null) : null,
      damageCharNo: values.hasNewDamage ? (values.damageCharNo ?? null) : null,
      note: values.note ?? '',
    };
    await dispatch(receiveCondition(draft)).unwrap();
    message.success('已收到状况记录；同一件以晚到为准，新损伤仅记借展侧');
    setConditionItem(null);
  };

  const columns: ColumnsType<LoanManifestItem> = [
    { title: '行号', dataIndex: 'lineNo', width: 64 },
    { title: '收藏号（外馆）', dataIndex: 'collectionNo', width: 130, render: (value: string) => value || '—' },
    { title: '展柜号', dataIndex: 'caseNo', width: 90, render: (value: string) => <Tag color="#3a6ea5">{value || '—'}</Tag> },
    {
      title: '外馆拓法记录',
      dataIndex: 'methodNote',
      width: 150,
      render: (value: string) => <Typography.Text type="secondary">{value || '—'}</Typography.Text>,
    },
    {
      title: '本馆对上拓本',
      key: 'rubbing',
      render: (_value, record) => {
        const rubbing = record.rubbingId ? rubbings.find((row) => row.id === record.rubbingId) : null;
        if (!rubbing) return <Tag>{LOAN_MATCH_STATE_LABEL[record.matchState]}</Tag>;
        return (
          <Space direction="vertical" size={0}>
            <Space size={4}>
              <Tag color="#2f3a34">{steleTitle(rubbing.steleId)}·第 {rubbing.versionNo} 版</Tag>
              <Tag color={RUBBING_LOAN_STATE_COLOR[rubbing.loanState]}>{RUBBING_LOAN_STATE_LABEL[rubbing.loanState]}</Tag>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本馆拓法：{RUBBING_METHOD_LABEL[rubbing.method]}（照旧不变）
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '对账状态',
      dataIndex: 'matchState',
      width: 110,
      render: (value: LoanManifestItem['matchState'], record) => (
        <Space direction="vertical" size={2}>
          {value === 'matched' ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              已对上
            </Tag>
          ) : (
            <Tag icon={<ClockCircleOutlined />} color="warning">
              待认领
            </Tag>
          )}
          {record.localRetryPending ? <Tag color="error">本侧待重试</Tag> : null}
        </Space>
      ),
    },
    {
      title: '最新状况（晚到为准）',
      key: 'condition',
      width: 200,
      render: (_value, record) => {
        if (!manifest) return '—';
        const latest = latestConditionFor(conditions, manifest.id, record.lineNo);
        if (!latest) return <Typography.Text type="secondary">暂无状况记录</Typography.Text>;
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>{latest.summary}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {latest.reportedOn}
              {latest.hasNewDamage ? ' · 报新损伤' : ''}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.matchState === 'unclaimed' ? (
            <Button size="small" type="link" onClick={() => openClaim(record)}>
              凭展柜号认上
            </Button>
          ) : (
            <Button
              size="small"
              type="link"
              onClick={() =>
                void dispatch(unclaimLoanItem({ manifestId: manifest!.id, lineNo: record.lineNo })).then(() =>
                  message.success('已撤回认领，拓本收回本馆'),
                )
              }
            >
              撤回认领
            </Button>
          )}
          <Button size="small" type="link" icon={<ExperimentOutlined />} onClick={() => openCondition(record)}>
            状况记录
          </Button>
          {record.localRetryPending ? (
            <Tag color="error" style={{ marginInlineEnd: 0 }}>
              本侧写库失败：{record.localWriteError || '未知错误'}
            </Tag>
          ) : null}
        </Space>
      ),
    },
  ];

  const damageRows = manifest ? loanSideDamages(conditions).filter((row) => row.manifestId === manifest.id) : [];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>外借展览对账</h2>
          <p>
            收下外馆点交单，先按收藏号、再按展柜号对账；对上的在本馆拓本挂借出标记（编目员填的拓法照旧），
            认不上的挂待认领。展期状况同一件以晚到为准，新损伤只记借展侧，不并入本馆损泐。
          </p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 240 }}
            placeholder="选择点交单"
            value={manifest?.id}
            options={manifests.map((row) => ({ value: row.id, label: `${row.venue} · ${row.exhibition}` }))}
            onChange={(value: string) => dispatch(setCurrentManifest(value))}
          />
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={openReceive}>
            收下点交单
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="点交单" value={stat.manifests} suffix="份" tone="primary" />
        <StatBadge label="借出拓本" value={stat.onLoan} suffix="份" tone="danger" />
        <StatBadge label="待认领" value={stat.unclaimed} suffix="条" tone="warning" />
        <StatBadge label="借展侧新损伤" value={stat.damages} suffix="处" tone="info" />
        <StatBadge label="本侧待重试" value={stat.retry} suffix="条" tone="danger" />
      </div>

      {!manifest ? (
        <Card className="gb-table-card" style={{ marginTop: 16 }}>
          <EmptyPanel
            title="还没有外借点交单"
            description="外馆把点交单交来后，在编目台收下：每行「收藏号，展柜号，拓法记录，备注」，自动按收藏号、再按展柜号对账。"
            actionText="收下点交单"
            onAction={openReceive}
          />
        </Card>
      ) : (
        <Row gutter={16}>
          <Col xs={24} xl={17}>
            <Card
              className="gb-table-card"
              styles={{ body: { padding: 0 } }}
              title={
                <Space wrap>
                  <Tag color="#2f3a34">{manifest.venue}</Tag>
                  <span>{manifest.exhibition}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    点交 {manifest.handoverDate} · 展期 {manifest.startDate} ~ {manifest.endDate}
                  </Typography.Text>
                </Space>
              }
              extra={
                <Space>
                  {manifest.items.some((item) => item.localRetryPending) ? (
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<RetweetOutlined />}
                      onClick={() =>
                        void dispatch(retryLocalWrites(manifest.id))
                          .unwrap()
                          .then((result) =>
                            result.retryCount === 0
                              ? message.success('本侧重试全部成功')
                              : message.warning(`仍有 ${result.retryCount} 条本侧写库失败`),
                          )
                      }
                    >
                      只重试本侧失败条
                    </Button>
                  ) : null}
                  <Popconfirm
                    title="删除该点交单"
                    description="将收回相关拓本的借出标记，并删除其借展状况记录。"
                    okText="确认"
                    cancelText="取消"
                    onConfirm={() =>
                      void dispatch(removeManifest(manifest.id)).then(() => message.success('点交单已删除'))
                    }
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              {manifest.items.some((item) => item.localRetryPending) ? (
                <Alert
                  type="error"
                  showIcon
                  style={{ margin: 12 }}
                  message="本侧部分拓本借出标记写库失败"
                  description="外馆点交单已原样留存、未改动；点「只重试本侧失败条」仅重写这几条本馆拓本标记。"
                />
              ) : null}
              <Table<LoanManifestItem>
                rowKey="lineNo"
                size="small"
                pagination={false}
                columns={columns}
                dataSource={[...manifest.items].sort((a, b) => a.lineNo - b.lineNo)}
              />
            </Card>
          </Col>

          <Col xs={24} xl={7}>
            <Card title="展期状况（晚到为准）" size="small" style={{ marginTop: 0 }}>
              {latestConditions.filter((row) => row.manifestId === manifest.id).length === 0 ? (
                <Typography.Text type="secondary">展期尚未收到状况记录。</Typography.Text>
              ) : (
                <Timeline
                  items={latestConditions
                    .filter((row) => row.manifestId === manifest.id)
                    .sort((a, b) => b.receivedAt - a.receivedAt)
                    .map((row) => ({
                      color: row.hasNewDamage ? 'red' : 'green',
                      children: (
                        <Space direction="vertical" size={2}>
                          <Typography.Text strong>
                            第 {row.lineNo} 行 · {row.reportedOn}
                          </Typography.Text>
                          <Typography.Text style={{ fontSize: 12 }}>{row.summary}</Typography.Text>
                          {row.hasNewDamage && row.damageType ? (
                            <LossTag
                              type={row.damageType}
                              severity={row.damageSeverity ?? undefined}
                              lineNo={row.damageLineNo ?? undefined}
                              charNo={row.damageCharNo ?? undefined}
                              note="借展期间新损伤，仅记借展侧"
                              size="small"
                            />
                          ) : null}
                        </Space>
                      ),
                    }))}
                />
              )}
            </Card>

            <Card title="借展侧新损伤（不并入本馆损泐）" size="small" style={{ marginTop: 16 }}>
              {damageRows.length === 0 ? (
                <Typography.Text type="secondary">本次借展暂无新损伤。</Typography.Text>
              ) : (
                <Space direction="vertical" size={6}>
                  <Alert
                    type="info"
                    showIcon
                    message="这些损伤只登记在借展侧"
                    description="不会写入本馆损泐字位表，也不影响版本比对与断代。"
                  />
                  {damageRows.map((row) => (
                    <Space key={row.id} size={6} wrap>
                      <Tag>第 {row.lineNo} 行</Tag>
                      {row.damageType ? (
                        <LossTag
                          type={row.damageType}
                          severity={row.damageSeverity ?? undefined}
                          lineNo={row.damageLineNo ?? undefined}
                          charNo={row.damageCharNo ?? undefined}
                          note={row.note}
                          size="small"
                        />
                      ) : null}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {row.reportedOn}
                      </Typography.Text>
                    </Space>
                  ))}
                </Space>
              )}
            </Card>
          </Col>
        </Row>
      )}

      {/* 收下点交单 */}
      <Modal
        open={receiveOpen}
        title="收下外馆点交单"
        okText="收下并对账"
        cancelText="取消"
        onCancel={() => setReceiveOpen(false)}
        onOk={() => void submitReceive()}
        width={680}
        destroyOnClose
      >
        <Form form={receiveForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="venue" label="外馆" rules={[{ required: true, message: '请填写外馆名称' }]} style={{ flex: 1 }}>
              <Input placeholder="如：临海市博物馆" />
            </Form.Item>
            <Form.Item name="exhibition" label="展览" rules={[{ required: true, message: '请填写展览名称' }]} style={{ flex: 1 }}>
              <Input placeholder="如：汉碑清赏拓片特展" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="handoverDate" label="点交日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="startDate" label="展期起" rules={[{ required: true }]} style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="endDate" label="展期止" rules={[{ required: true }]} style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item
            name="rawText"
            label="点交单内容（每行：收藏号，展柜号，拓法记录，备注）"
            rules={[{ required: true, message: '请粘贴点交单内容' }]}
            extra="先按收藏号对；收藏号认不上的保留展柜号挂待认领，人工凭展柜号认上。"
          >
            <TextArea rows={6} placeholder="TB-0101，A-12，擦拓，礼器碑明拓" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 人工认上 */}
      <Modal
        open={!!claimItem}
        title={`凭展柜号认上 · 展柜号 ${claimItem?.caseNo || '—'}`}
        okText="确认认上"
        cancelText="取消"
        onCancel={() => setClaimItem(null)}
        onOk={() => void submitClaim()}
        destroyOnClose
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text>
            外馆收藏号「{claimItem?.collectionNo || '未填'}」在本馆认不上；请据展柜号核对并选择对应的本馆拓本。
          </Typography.Text>
          <Select
            showSearch
            style={{ width: '100%' }}
            placeholder="选择本馆拓本"
            value={claimRubbingId}
            optionFilterProp="label"
            options={rubbings
              .filter((rubbing) => rubbing.loanState !== 'onLoan')
              .map((rubbing) => ({
                value: rubbing.id,
                label: `${rubbing.collectionNo || '未编收藏号'} · ${steleTitle(rubbing.steleId)}·第 ${
                  rubbing.versionNo
                } 版 · ${RUBBING_METHOD_LABEL[rubbing.method]}`,
              }))}
            onChange={(value: string) => setClaimRubbingId(value)}
          />
          <Alert type="info" showIcon message="认上后只挂借出标记，本馆拓法等编目字段保持原样。" />
        </Space>
      </Modal>

      {/* 状况记录 */}
      <Modal
        open={!!conditionItem}
        title={`外馆状况记录 · 第 ${conditionItem?.lineNo ?? ''} 行（展柜号 ${conditionItem?.caseNo ?? '—'}）`}
        okText="登记状况"
        cancelText="取消"
        onCancel={() => setConditionItem(null)}
        onOk={() => void submitCondition()}
        destroyOnClose
      >
        <Form form={conditionForm} layout="vertical" preserve={false}>
          <Form.Item name="reportedOn" label="外馆记录日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="summary" label="状况摘要" rules={[{ required: true, message: '请填写状况摘要' }]}>
            <Input placeholder="如：纸本完好 / 边角微卷" />
          </Form.Item>
          <Form.Item name="hasNewDamage" label="是否报告新损伤" valuePropName="checked">
            <Select
              style={{ width: 200 }}
              options={[
                { value: false, label: '无新损伤' },
                { value: true, label: '有新损伤（仅记借展侧）' },
              ]}
            />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() =>
              conditionForm.getFieldValue('hasNewDamage') ? (
                <>
                  <Space size={12} style={{ display: 'flex' }}>
                    <Form.Item name="damageType" label="损伤类型" rules={[{ required: true }]} style={{ flex: 1 }}>
                      <Select options={[...LOSS_TYPE_OPTIONS]} />
                    </Form.Item>
                    <Form.Item name="damageSeverity" label="程度" rules={[{ required: true }]} style={{ flex: 1 }}>
                      <Select options={[...LOSS_SEVERITY_OPTIONS]} />
                    </Form.Item>
                  </Space>
                  <Space size={12} style={{ display: 'flex' }}>
                    <Form.Item name="damageLineNo" label="行号" style={{ flex: 1 }}>
                      <Input type="number" min={1} />
                    </Form.Item>
                    <Form.Item name="damageCharNo" label="字位" style={{ flex: 1 }}>
                      <Input type="number" min={1} />
                    </Form.Item>
                  </Space>
                </>
              ) : null
            }
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="外馆备注" />
          </Form.Item>
          <Alert type="warning" showIcon message="同一件多次记录以晚到的为准；新损伤只记借展侧，不并入本馆损泐。" />
        </Form>
      </Modal>
    </div>
  );
}
