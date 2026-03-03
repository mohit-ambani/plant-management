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
} from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
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
        <Tag color={status === "activated" ? "green" : "orange"}>
          {status.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: "Created At",
      dataIndex: "created_at",
      key: "created_at",
    },
    {
      title: "Activated At",
      dataIndex: "activated_at",
      key: "activated_at",
      render: (val) => val || "—",
    },
  ];

  if (!batch) return null;

  const width = String(batch.end_number).length;

  return (
    <Modal
      title={`Batch: ${batch.batch_code}`}
      open={open}
      onCancel={onClose}
      width={900}
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
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Batch Code">{batch.batch_code}</Descriptions.Item>
        <Descriptions.Item label="SKU ID">{batch.sku_id}</Descriptions.Item>
        <Descriptions.Item label="Serial Range">
          <Text code>
            {batch.prefix}{String(batch.start_number + 1).padStart(width, "0")} —{" "}
            {batch.prefix}{String(batch.end_number).padStart(width, "0")}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label="Quantity">
          <Text strong>{batch.quantity.toLocaleString()}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Production Date">{batch.production_date}</Descriptions.Item>
        <Descriptions.Item label="Status">
          <Tag color={batch.status === "activated" ? "green" : "blue"}>
            {batch.status.toUpperCase()}
          </Tag>
        </Descriptions.Item>
      </Descriptions>

      <Space style={{ marginBottom: 12 }}>
        <Text type="secondary">Filter:</Text>
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
        scroll={{ y: 400 }}
      />
    </Modal>
  );
}
