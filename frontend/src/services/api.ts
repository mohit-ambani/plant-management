import axios from "axios";

const api = axios.create({
  baseURL: "/api",
});

export interface Batch {
  id: number;
  batch_code: string;
  sku_id: string;
  prefix: string;
  start_number: number;
  end_number: number;
  quantity: number;
  production_date: string;
  created_at: string;
  status: string;
  activated_count?: number;
}

export interface SerialNumber {
  id: number;
  batch_id: number;
  serial_number: string;
  batch_code: string;
  sku_id: string;
  status: string;
  activated_at: string | null;
  created_at: string;
}

export interface PaginatedSerials {
  serials: SerialNumber[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const createBatch = (data: {
  startSerial: string;
  endSerial: string;
  batchCode: string;
  skuId: string;
  productionDate: string;
}) => api.post<{ message: string; batch: Batch }>("/batches", data);

export const getBatches = () => api.get<Batch[]>("/batches");

export const getBatchDetail = (id: number) =>
  api.get<{ batch: Batch; serials: SerialNumber[] }>(`/batches/${id}`);

export const getBatchSerials = (
  id: number,
  page: number = 1,
  limit: number = 50,
  status?: string
) => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) params.set("status", status);
  return api.get<PaginatedSerials>(`/batches/${id}/serials?${params}`);
};

export const activateBatch = (id: number) =>
  api.post<{
    message: string;
    activated: number;
    errors: number;
    errorDetails: any[];
  }>(`/batches/${id}/activate`);

export const deleteBatch = (id: number) =>
  api.delete<{ message: string }>(`/batches/${id}`);
