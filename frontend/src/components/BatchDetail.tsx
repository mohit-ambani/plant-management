import { useState, useEffect } from "react";
import {
  Modal,
  Table,
  Tag,
  Descriptions,
  Space,
  Button,
  Select,
  message,
  Typography,
  Statistic,
  Row,
  Col,
  Divider,
} from "antd";
import {
  ThunderboltOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  Batch,
  SerialNumber,
  getBatchSerials,
  activateBatch,
} from "../services/api";

const { Text } = Typography;

interface BatchDetailProps {
  batch: Batch | null;
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

export default function BatchDetail({
  batch,
  open,
  onClose,
  onRefresh,
}: BatchDetailProps) {
  const [serials, setSerials] = useState<SerialNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [activating, setActivating] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const pageSize = 50;

  const fetchSerials = async () => {
    if (!batch) return;
    setLoading(true);
    try {
      const res = await getBatchSerials(batch.id, page, pageSize, statusFilter);
      setSerials(res.data.serials);
      setTotal(res.data.total);
    } catch {
      message.error("Failed to load serial numbers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && batch) {
      setPage(1);
      fetchSerials();
    }
  }, [open, batch, statusFilter]);

  useEffect(() => {
    if (open && batch) fetchSerials();
  }, [page]);

  const handleActivate = async () => {
    if (!batch) return;
    setActivating(true);
    try {
      const res = await activateBatch(batch.id);
      message.success(res.data.message);
      fetchSerials();
      onRefresh();
    } catch (err: any) {
      message.error(err.response?.data?.error || "Activation failed");
    } finally {
      setActivating(false);
    }
  };

  const columns: ColumnsType<SerialNumber> = [
    {
      title: "Serial Number",
      dataIndex: "serial_number",
      key: "serial_number",
      render: (text) => <Text code>{text}</Text>,
    },
    {
      title: "Batch Code",
      dataIndex: "batch_code",
      key: "batch_code",
    },
    {
      title: "SKU ID",
      dataIndex: "sku_id",
      key: "sku_id",
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status) => (
        <Tag
          color={status === "activated" ? "green" : "orange"}
          icon={
            status === "activated" ? (
              <CheckCircleOutlined />
            ) : (
              <ClockCircleOutlined />
            )
          }
        >
          {status.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: "Created At",
      dataIndex: "created_at",
      key: "created_at",
      render: (val) => val ? new Date(val).toLocaleString() : "—",
    },
    {
      title: "Activated At",
      dataIndex: "activated_at",
      key: "activated_at",
      render: (val) => val ? new Date(val).toLocaleString() : "—",
    },
  ];

  if (!batch) return null;

  const width = String(batch.end_number).length;
  const activatedCount = batch.activated_count || 0;
  const pendingCount = batch.quantity - activatedCount;

  return (
    <Modal
      title={`Batch: ${batch.batch_code}`}
      open={open}
      onCancel={onClose}
      width={1000}
      footer={[
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
        batch.status !== "activated" && (
          <Button
            key="activate"
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={handleActivate}
            loading={activating}
          >
            Activate All Pending
          </Button>
        ),
      ]}
    >
      <Descriptions
        bordered
        size="small"
        column={{ xs: 1, sm: 2, md: 3 }}
        style={{ marginBottom: 16 }}
      >
        <Descriptions.Item label="Batch Code">
          <Text strong>{batch.batch_code}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="SKU ID">{batch.sku_id}</Descriptions.Item>
        <Descriptions.Item label="Status">
          <Tag color={batch.status === "activated" ? "green" : "blue"}>
            {batch.status.toUpperCase()}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Serial Range">
          <Text code>
            {batch.prefix}
            {String(batch.start_number + 1).padStart(width, "0")} —{" "}
            {batch.prefix}
            {String(batch.end_number).padStart(width, "0")}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label="Quantity">
          <Text strong>{batch.quantity.toLocaleString()}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Prefix">
          <Text code>{batch.prefix}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Production Date">
          {batch.production_date}
        </Descriptions.Item>
        <Descriptions.Item label="Role Number">
          {batch.role_number || "—"}
        </Descriptions.Item>
        <Descriptions.Item label="Created At">
          {new Date(batch.created_at).toLocaleString()}
        </Descriptions.Item>
      </Descriptions>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={8}>
          <Statistic
            title="Total"
            value={batch.quantity}
            valueStyle={{ fontSize: 20 }}
          />
        </Col>
        <Col xs={8}>
          <Statistic
            title="Activated"
            value={activatedCount}
            valueStyle={{ color: "#52c41a", fontSize: 20 }}
            prefix={<CheckCircleOutlined />}
          />
        </Col>
        <Col xs={8}>
          <Statistic
            title="Pending"
            value={pendingCount}
            valueStyle={{ color: pendingCount > 0 ? "#faad14" : "#52c41a", fontSize: 20 }}
            prefix={<ClockCircleOutlined />}
          />
        </Col>
      </Row>

      <Divider style={{ margin: "8px 0 12px" }} />

      <Space style={{ marginBottom: 12 }}>
        <Text type="secondary">Filter by status:</Text>
        <Select
          placeholder="All statuses"
          allowClear
          onChange={(val) => {
            setStatusFilter(val);
            setPage(1);
          }}
          style={{ width: 150 }}
          options={[
            { label: "Pending", value: "pending" },
            { label: "Activated", value: "activated" },
          ]}
        />
      </Space>

      <Table
        columns={columns}
        dataSource={serials}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: setPage,
          showTotal: (t) => `Total: ${t.toLocaleString()}`,
          showSizeChanger: false,
        }}
        scroll={{ y: 350 }}
      />
    </Modal>
  );
}
