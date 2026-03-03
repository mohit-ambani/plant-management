import { useState } from "react";
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  Popconfirm,
  message,
  Progress,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  ThunderboltOutlined,
  EyeOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { Batch, activateBatch, deleteBatch } from "../services/api";

const { Text } = Typography;

interface BatchListProps {
  batches: Batch[];
  loading: boolean;
  onRefresh: () => void;
  onViewDetail: (batch: Batch) => void;
}

export default function BatchList({
  batches,
  loading,
  onRefresh,
  onViewDetail,
}: BatchListProps) {
  const [activatingId, setActivatingId] = useState<number | null>(null);

  const handleActivate = async (id: number) => {
    setActivatingId(id);
    try {
      const res = await activateBatch(id);
      message.success(res.data.message);
      onRefresh();
    } catch (err: any) {
      message.error(err.response?.data?.error || "Activation failed");
    } finally {
      setActivatingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteBatch(id);
      message.success("Batch deleted");
      onRefresh();
    } catch (err: any) {
      message.error(err.response?.data?.error || "Delete failed");
    }
  };

  const columns: ColumnsType<Batch> = [
    {
      title: "Batch Code",
      dataIndex: "batch_code",
      key: "batch_code",
      render: (text) => <Text strong>{text}</Text>,
    },
    {
      title: "SKU ID",
      dataIndex: "sku_id",
      key: "sku_id",
    },
    {
      title: "Serial Range",
      key: "range",
      render: (_, record) => {
        const width = String(record.end_number).length;
        const start = `${record.prefix}${String(record.start_number + 1).padStart(width, "0")}`;
        const end = `${record.prefix}${String(record.end_number).padStart(width, "0")}`;
        return (
          <Text code>
            {start} — {end}
          </Text>
        );
      },
    },
    {
      title: "Quantity",
      dataIndex: "quantity",
      key: "quantity",
      render: (qty) => <Text strong>{qty.toLocaleString()}</Text>,
      sorter: (a, b) => a.quantity - b.quantity,
    },
    {
      title: "Production Date",
      dataIndex: "production_date",
      key: "production_date",
      sorter: (a, b) => a.production_date.localeCompare(b.production_date),
    },
    {
      title: "Activation",
      key: "activation",
      render: (_, record) => {
        const activated = record.activated_count || 0;
        const percent = record.quantity > 0 ? Math.round((activated / record.quantity) * 100) : 0;
        return (
          <Space direction="vertical" size={0} style={{ width: 120 }}>
            <Progress percent={percent} size="small" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {activated.toLocaleString()} / {record.quantity.toLocaleString()}
            </Text>
          </Space>
        );
      },
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status) => {
        const color = status === "activated" ? "green" : status === "created" ? "blue" : "default";
        return <Tag color={color}>{status.toUpperCase()}</Tag>;
      },
      filters: [
        { text: "Created", value: "created" },
        { text: "Activated", value: "activated" },
      ],
      onFilter: (value, record) => record.status === value,
    },
    {
      title: "Actions",
      key: "actions",
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={() => onViewDetail(record)}
            size="small"
          >
            View
          </Button>
          {record.status !== "activated" && (
            <Button
              type="link"
              icon={<ThunderboltOutlined />}
              onClick={() => handleActivate(record.id)}
              loading={activatingId === record.id}
              size="small"
            >
              Activate
            </Button>
          )}
          <Popconfirm
            title="Delete this batch?"
            description="All serial numbers in this batch will be permanently deleted."
            onConfirm={() => handleDelete(record.id)}
            okText="Delete"
            okType="danger"
          >
            <Button type="link" danger icon={<DeleteOutlined />} size="small">
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <UnorderedListOutlined />
          <span>Batch Records</span>
        </Space>
      }
      extra={
        <Text type="secondary">
          {batches.length} batch{batches.length !== 1 ? "es" : ""}
        </Text>
      }
    >
      <Table
        columns={columns}
        dataSource={batches}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `Total: ${t}` }}
        size="middle"
        scroll={{ x: 900 }}
      />
    </Card>
  );
}
