import { useState, useEffect, useCallback } from "react";
import BatchList from "../components/BatchList";
import BatchDetail from "../components/BatchDetail";
import GlobalSearch from "../components/GlobalSearch";
import { Batch, getBatches } from "../services/api";

export default function BatchRecords() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getBatches();
      setBatches(res.data);
    } catch {
      // silently fail
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
    <>
      <GlobalSearch />
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
    </>
  );
}
