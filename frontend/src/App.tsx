import { useState, useEffect, useCallback } from "react";
import { Layout, Typography, theme, Spin } from "antd";
import BatchForm from "./components/BatchForm";
import BatchList from "./components/BatchList";
import BatchDetail from "./components/BatchDetail";
import { Batch, getBatches } from "./services/api";

const { Header, Content } = Layout;
const { Title } = Typography;

export default function App() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const {
    token: { colorBgContainer, borderRadiusLG },
  } = theme.useToken();

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getBatches();
      setBatches(res.data);
    } catch {
      // silently fail, table will be empty
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBatches();
  }, [fetchBatches]);

  const handleViewDetail = (batch: Batch) => {
    setSelectedBatch(batch);
    setDetailOpen(true);
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          background: colorBgContainer,
          borderBottom: "1px solid #f0f0f0",
          padding: "0 24px",
        }}
      >
        <Title level={4} style={{ margin: 0 }}>
          Plant Management System
        </Title>
      </Header>

      <Content style={{ padding: "24px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        <BatchForm onSuccess={fetchBatches} />
        <BatchList
          batches={batches}
          loading={loading}
          onRefresh={fetchBatches}
          onViewDetail={handleViewDetail}
        />
        <BatchDetail
          batch={selectedBatch}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          onRefresh={fetchBatches}
        />
      </Content>
    </Layout>
  );
}
