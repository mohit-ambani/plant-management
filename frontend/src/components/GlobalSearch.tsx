import { useState } from "react";
import {
  Card,
  Input,
  Table,
  Tag,
  Typography,
  Space,
  Empty,
  message,
} from "antd";
import { SearchOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { search, SearchResult } from "../services/api";

const { Text } = Typography;

export default function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (value: string) => {
    const q = value.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const res = await search(q);
      setResults(res.data);
    } catch {
      message.error("Search failed");
    } finally {
      setLoading(false);
    }
  };

  const columns: ColumnsType<SearchResult> = [
    {
      title: "Type",
      key: "type",
      width: 80,
      render: (_, r) => (
        <Tag color={r.type === "serial" ? "purple" : "blue"}>
          {r.type === "serial" ? "Serial" : "Batch"}
        </Tag>
      ),
    },
    {
      title: "Serial Number",
      key: "serial_number",
      render: (_, r) =>
        r.serial_number ? <Text code>{r.serial_number}</Text> : "—",
    },
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
      title: "Role Number",
      dataIndex: "role_number",
      key: "role_number",
      render: (val) => val || "—",
    },
    {
      title: "Serial Range",
      key: "range",
      render: (_, r) => {
        const width = String(r.end_number).length;
        const start = `${r.prefix}${String(r.start_number + 1).padStart(width, "0")}`;
        const end = `${r.prefix}${String(r.end_number).padStart(width, "0")}`;
        return <Text code>{start} — {end}</Text>;
      },
    },
    {
      title: "Quantity",
      dataIndex: "quantity",
      key: "quantity",
      render: (qty) => qty.toLocaleString(),
    },
    {
      title: "Production Date",
      dataIndex: "production_date",
      key: "production_date",
    },
    {
      title: "Status",
      key: "status",
      render: (_, r) => {
        const status = r.type === "serial" ? r.serial_status : r.batch_status;
        const color =
          status === "activated" ? "green" : status === "pending" ? "orange" : "blue";
        return <Tag color={color}>{(status || "").toUpperCase()}</Tag>;
      },
    },
  ];

  return (
    <Card
      title={
        <Space>
          <SearchOutlined />
          <span>Search Batches & Serial Numbers</span>
        </Space>
      }
      style={{ marginBottom: 24 }}
    >
      <Input.Search
        placeholder="Search by batch code, serial number, or role number..."
        allowClear
        enterButton="Search"
        size="large"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={handleSearch}
        loading={loading}
      />
      {searched && (
        <div style={{ marginTop: 16 }}>
          {results.length === 0 && !loading ? (
            <Empty description="No results found" />
          ) : (
            <Table
              columns={columns}
              dataSource={results}
              rowKey={(r, i) =>
                r.type === "serial"
                  ? `s-${r.serial_number}`
                  : `b-${r.batch_id}-${i}`
              }
              loading={loading}
              size="small"
              pagination={{ pageSize: 10, showTotal: (t) => `${t} result${t !== 1 ? "s" : ""}` }}
              scroll={{ x: 900 }}
            />
          )}
        </div>
      )}
    </Card>
  );
}
