import { useState, useMemo } from "react";
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  message,
  Progress,
  Typography,
  Input,
  DatePicker,
  Row,
  Col,
} from "antd";
import {
  ThunderboltOutlined,
  EyeOutlined,
  UnorderedListOutlined,
  SearchOutlined,
  ClearOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { Batch, activateBatch } from "../services/api";

const { Text } = Typography;
const { RangePicker } = DatePicker;

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
  const [searchText, setSearchText] = useState("");
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);

  const filteredBatches = useMemo(() => {
    let result = batches;

    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      result = result.filter(
        (b) =>
          b.batch_code.toLowerCase().includes(q) ||
          b.sku_id.toLowerCase().includes(q) ||
          (b.role_number && b.role_number.toLowerCase().includes(q))
      );
    }

    if (dateRange && dateRange[0] && dateRange[1]) {
      const start = dateRange[0].startOf("day");
      const end = dateRange[1].endOf("day");
      result = result.filter((b) => {
        const d = dayjs(b.production_date);
        return d.isAfter(start.subtract(1, "ms")) && d.isBefore(end.add(1, "ms"));
      });
    }

    return result;
  }, [batches, searchText, dateRange]);

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

  const clearFilters = () => {
    setSearchText("");
    setDateRange(null);
  };

  const hasFilters = searchText.trim() || (dateRange && dateRange[0]);

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
      title: "Role Number",
      dataIndex: "role_number",
      key: "role_number",
      render: (val) => val || "—",
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
        <Space>
          <Text type="secondary">
            {hasFilters
              ? `${filteredBatches.length} of ${batches.length} batch${batches.length !== 1 ? "es" : ""}`
              : `${batches.length} batch${batches.length !== 1 ? "es" : ""}`}
          </Text>
          <Button
            icon={<DownloadOutlined />}
            href="/api/batches/download"
          >
            Download Excel
          </Button>
        </Space>
      }
    >
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={10}>
          <Input
            placeholder="Search by batch code, SKU, or role number..."
            prefix={<SearchOutlined />}
            allowClear
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </Col>
        <Col xs={24} sm={10}>
          <RangePicker
            style={{ width: "100%" }}
            placeholder={["Production from", "Production to"]}
            value={dateRange}
            onChange={(dates) => setDateRange(dates)}
            format="YYYY-MM-DD"
          />
        </Col>
        <Col xs={24} sm={4}>
          {hasFilters && (
            <Button icon={<ClearOutlined />} onClick={clearFilters} block>
              Clear
            </Button>
          )}
        </Col>
      </Row>

      <Table
        columns={columns}
        dataSource={filteredBatches}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `Total: ${t}` }}
        size="middle"
        scroll={{ x: 1000 }}
      />
    </Card>
  );
}
