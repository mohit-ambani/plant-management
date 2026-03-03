import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Table,
  DatePicker,
  Button,
  Space,
  Tag,
  message,
  Row,
  Col,
  Statistic,
  Modal,
  Typography,
  Descriptions,
} from "antd";
import {
  ApiOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import {
  exportBatches,
  getApiLogs,
  ApiLog,
  ExportResponse,
} from "../services/api";

const { RangePicker } = DatePicker;
const { Text } = Typography;

export default function ApiLogs() {
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
  const [lastResult, setLastResult] = useState<ExportResponse | null>(null);
  const [detailLog, setDetailLog] = useState<ApiLog | null>(null);

  const fetchLogs = useCallback(async (p: number = 1) => {
    setLogsLoading(true);
    try {
      const res = await getApiLogs(p);
      setLogs(res.data.logs);
      setTotal(res.data.total);
      setPage(res.data.page);
    } catch {
      // silently fail
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleExport = async () => {
    if (!dateRange) {
      message.warning("Please select a date range");
      return;
    }

    const from = dateRange[0].format("YYYY-MM-DD");
    const to = dateRange[1].format("YYYY-MM-DD");

    setLoading(true);
    try {
      const res = await exportBatches(from, to);
      setLastResult(res.data);
      message.success(res.data.message);
      fetchLogs(); // refresh logs
    } catch (err: any) {
      message.error(err.response?.data?.error || "API call failed");
      setLastResult(null);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: "Time",
      dataIndex: "created_at",
      key: "created_at",
      width: 180,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
    {
      title: "Endpoint",
      dataIndex: "endpoint",
      key: "endpoint",
      width: 160,
    },
    {
      title: "Method",
      dataIndex: "method",
      key: "method",
      width: 80,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: "Status",
      dataIndex: "success",
      key: "success",
      width: 100,
      render: (success: boolean, record: ApiLog) =>
        success ? (
          <Tag icon={<CheckCircleOutlined />} color="success">
            {record.status_code}
          </Tag>
        ) : (
          <Tag icon={<CloseCircleOutlined />} color="error">
            {record.status_code}
          </Tag>
        ),
    },
    {
      title: "Batches",
      dataIndex: "batches_count",
      key: "batches_count",
      width: 90,
      align: "center" as const,
    },
    {
      title: "Activated",
      dataIndex: "serials_activated",
      key: "serials_activated",
      width: 100,
      align: "center" as const,
    },
    {
      title: "Request",
      dataIndex: "request_params",
      key: "request_params",
      width: 200,
      render: (v: any) => (
        <Text code style={{ fontSize: 12 }}>
          {typeof v === "string" ? v : JSON.stringify(v)}
        </Text>
      ),
    },
    {
      title: "Error",
      dataIndex: "error_message",
      key: "error_message",
      ellipsis: true,
      render: (v: string | null) =>
        v ? (
          <Text type="danger" style={{ fontSize: 12 }}>
            {v}
          </Text>
        ) : (
          "-"
        ),
    },
    {
      title: "",
      key: "actions",
      width: 60,
      render: (_: any, record: ApiLog) => (
        <Button
          type="text"
          icon={<EyeOutlined />}
          onClick={() => setDetailLog(record)}
        />
      ),
    },
  ];

  return (
    <>
      <Card
        title={
          <Space>
            <ApiOutlined />
            <span>Export API - Fetch & Activate Batches</span>
          </Space>
        }
        style={{ marginBottom: 24 }}
      >
        <Row gutter={16} align="middle">
          <Col>
            <RangePicker
              size="large"
              format="YYYY-MM-DD"
              value={dateRange}
              onChange={(dates) =>
                setDateRange(dates as [dayjs.Dayjs, dayjs.Dayjs] | null)
              }
            />
          </Col>
          <Col>
            <Button
              type="primary"
              size="large"
              icon={<PlayCircleOutlined />}
              loading={loading}
              onClick={handleExport}
              disabled={!dateRange}
            >
              Call Export API
            </Button>
          </Col>
        </Row>

        {lastResult && (
          <Row gutter={24} style={{ marginTop: 24 }}>
            <Col>
              <Statistic
                title="Batches Found"
                value={lastResult.totalBatches}
                valueStyle={{ color: "#1677ff" }}
              />
            </Col>
            <Col>
              <Statistic
                title="Total Serials"
                value={lastResult.totalSerials}
              />
            </Col>
            <Col>
              <Statistic
                title="Serials Activated"
                value={lastResult.serialsActivated}
                valueStyle={{ color: "#52c41a" }}
              />
            </Col>
            <Col>
              <Statistic
                title="Date Range"
                value={`${lastResult.from} to ${lastResult.to}`}
                valueStyle={{ fontSize: 16 }}
              />
            </Col>
          </Row>
        )}
      </Card>

      <Card
        title={
          <Space>
            <ApiOutlined />
            <span>API Call History</span>
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => fetchLogs(page)}>
            Refresh
          </Button>
        }
      >
        <Table
          dataSource={logs}
          columns={columns}
          rowKey="id"
          loading={logsLoading}
          size="small"
          pagination={{
            current: page,
            total,
            pageSize: 50,
            showTotal: (t) => `${t} log entries`,
            onChange: (p) => fetchLogs(p),
          }}
        />
      </Card>

      <Modal
        title="API Call Detail"
        open={!!detailLog}
        onCancel={() => setDetailLog(null)}
        footer={null}
        width={700}
      >
        {detailLog && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Time">
              {dayjs(detailLog.created_at).format("YYYY-MM-DD HH:mm:ss")}
            </Descriptions.Item>
            <Descriptions.Item label="Endpoint">
              {detailLog.endpoint}
            </Descriptions.Item>
            <Descriptions.Item label="Method">
              {detailLog.method}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              {detailLog.success ? (
                <Tag color="success">Success ({detailLog.status_code})</Tag>
              ) : (
                <Tag color="error">Failed ({detailLog.status_code})</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Batches">
              {detailLog.batches_count}
            </Descriptions.Item>
            <Descriptions.Item label="Serials Activated">
              {detailLog.serials_activated}
            </Descriptions.Item>
            <Descriptions.Item label="Request Params">
              <pre style={{ margin: 0, fontSize: 12, maxHeight: 200, overflow: "auto" }}>
                {JSON.stringify(
                  typeof detailLog.request_params === "string"
                    ? JSON.parse(detailLog.request_params)
                    : detailLog.request_params,
                  null,
                  2
                )}
              </pre>
            </Descriptions.Item>
            <Descriptions.Item label="Response">
              <pre style={{ margin: 0, fontSize: 12, maxHeight: 300, overflow: "auto" }}>
                {JSON.stringify(
                  typeof detailLog.response_data === "string"
                    ? JSON.parse(detailLog.response_data)
                    : detailLog.response_data,
                  null,
                  2
                )}
              </pre>
            </Descriptions.Item>
            {detailLog.error_message && (
              <Descriptions.Item label="Error">
                <Text type="danger">{detailLog.error_message}</Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Modal>
    </>
  );
}
