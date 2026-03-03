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
  role_number: string | null;
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
  ranges: { startSerial: string; endSerial: string }[];
  batchCode: string;
  skuId: string;
  productionDate: string;
  roleNumber?: string;
}) => api.post<{
  message: string;
  batch: Batch;
  externalApi: { status: number; success: boolean; response: string } | null;
  samplePayloadSent: any;
}>("/batches", data);

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

export interface SearchResult {
  type: "batch" | "serial";
  serial_number?: string;
  batch_code: string;
  sku_id: string;
  role_number: string | null;
  production_date: string;
  quantity: number;
  prefix: string;
  start_number: number;
  end_number: number;
  batch_id: number;
  batch_status: string;
  serial_status?: string;
  serial_created_at?: string;
  serial_activated_at?: string | null;
  batch_created_at: string;
}

export const search = (query: string) =>
  api.get<SearchResult[]>(`/batches/search?q=${encodeURIComponent(query)}`);

export interface ExportResponse {
  message: string;
  totalBatches: number;
  totalSerials: number;
  serialsActivated: number;
  from: string;
  to: string;
  batches: (Batch & { serials: SerialNumber[] })[];
}

export const exportBatches = (from: string, to: string) =>
  api.get<ExportResponse>(`/batches/export?from=${from}&to=${to}`);

export interface ApiLog {
  id: number;
  endpoint: string;
  method: string;
  request_params: any;
  response_data: any;
  status_code: number;
  success: boolean;
  error_message: string | null;
  batches_count: number;
  serials_activated: number;
  created_at: string;
}

export interface PaginatedLogs {
  logs: ApiLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const getApiLogs = (page: number = 1, limit: number = 50) =>
  api.get<PaginatedLogs>(`/logs?page=${page}&limit=${limit}`);

export const getSettings = () =>
  api.get<Record<string, string>>("/settings");

export const updateSetting = (key: string, value: string) =>
  api.put<{ message: string; key: string; value: string }>("/settings", { key, value });
