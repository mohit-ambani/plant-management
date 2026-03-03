import { useState, useEffect, useCallback } from "react";
import {
  Form,
  Input,
  DatePicker,
  Button,
  Card,
  Statistic,
  Row,
  Col,
  message,
  Alert,
  Space,
  Divider,
  Typography,
} from "antd";
import {
  PlusOutlined,
  NumberOutlined,
  BarcodeOutlined,
  CalendarOutlined,
  TagOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { createBatch } from "../services/api";

const { Text } = Typography;

interface BatchFormProps {
  onSuccess: () => void;
}

function parseSerial(serial: string): { prefix: string; number: number; width: number } | null {
  const match = serial.match(/^([A-Za-z])(\d+)$/);
  if (!match) return null;
  return { prefix: match[1].toUpperCase(), number: parseInt(match[2], 10), width: match[2].length };
}

export default function BatchForm({ onSuccess }: BatchFormProps) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [serialPreview, setSerialPreview] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const calculateQuantity = useCallback(() => {
    const startSerial = form.getFieldValue("startSerial") || "";
    const endSerial = form.getFieldValue("endSerial") || "";

    if (!startSerial || !endSerial) {
      setQuantity(null);
      setSerialPreview([]);
      setError(null);
      return;
    }

    const start = parseSerial(startSerial);
    const end = parseSerial(endSerial);

    if (!start || !end) {
      setQuantity(null);
      setSerialPreview([]);
      setError("Invalid serial format. Use 1 letter (A-Z) + digits (e.g., A1, A100000)");
      return;
    }

    if (start.prefix !== end.prefix) {
      setQuantity(null);
      setSerialPreview([]);
      setError("Prefix mismatch between start and end serials");
      return;
    }

    if (end.number <= start.number) {
      setQuantity(null);
      setSerialPreview([]);
      setError("End serial must be greater than start serial");
      return;
    }

    const qty = end.number - start.number;
    setQuantity(qty);
    setError(null);

    // Generate preview (first 3 and last 2)
    const width = start.width;
    const prefix = start.prefix;
    const preview: string[] = [];
    if (qty <= 5) {
      for (let i = start.number + 1; i <= end.number; i++) {
        preview.push(`${prefix}${String(i).padStart(width, "0")}`);
      }
    } else {
      preview.push(`${prefix}${String(start.number + 1).padStart(width, "0")}`);
      preview.push(`${prefix}${String(start.number + 2).padStart(width, "0")}`);
      preview.push(`${prefix}${String(start.number + 3).padStart(width, "0")}`);
      preview.push("...");
      preview.push(`${prefix}${String(end.number - 1).padStart(width, "0")}`);
      preview.push(`${prefix}${String(end.number).padStart(width, "0")}`);
    }
    setSerialPreview(preview);
  }, [form]);

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      await createBatch({
        startSerial: values.startSerial,
        endSerial: values.endSerial,
        batchCode: values.batchCode,
        skuId: values.skuId,
        productionDate: values.productionDate.format("YYYY-MM-DD"),
        roleNumber: values.roleNumber || undefined,
      });
      message.success(`Batch created successfully with ${quantity} serial numbers`);
      form.resetFields();
      setQuantity(null);
      setSerialPreview([]);
      onSuccess();
    } catch (err: any) {
      message.error(err.response?.data?.error || "Failed to create batch");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      title={
        <Space>
          <PlusOutlined />
          <span>New Batch Entry</span>
        </Space>
      }
      style={{ marginBottom: 24 }}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        size="large"
        initialValues={{ productionDate: dayjs(), skuId: "Sku2" }}
      >
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item
              name="startSerial"
              label="Starting Serial Number"
              rules={[
                { required: true, message: "Enter starting serial" },
                {
                  pattern: /^[A-Za-z]\d+$/,
                  message: "Format: 1 letter (A-Z) + digits (e.g., A1, A100000)",
                },
              ]}
            >
              <Input
                prefix={<BarcodeOutlined />}
                placeholder="e.g., A100000"
                onChange={() => setTimeout(calculateQuantity, 0)}
                autoFocus
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="endSerial"
              label="Ending Serial Number"
              rules={[
                { required: true, message: "Enter ending serial" },
                {
                  pattern: /^[A-Za-z]\d+$/,
                  message: "Format: 1 letter (A-Z) + digits (e.g., A10000)",
                },
              ]}
            >
              <Input
                prefix={<BarcodeOutlined />}
                placeholder="e.g., A10000"
                onChange={() => setTimeout(calculateQuantity, 0)}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col xs={24} sm={6}>
            <Form.Item
              name="batchCode"
              label="Batch Code"
              rules={[{ required: true, message: "Enter batch code" }]}
            >
              <Input prefix={<TagOutlined />} placeholder="e.g., BATCH-2024-001" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={6}>
            <Form.Item
              name="skuId"
              label="SKU ID"
              rules={[{ required: true, message: "Enter SKU ID" }]}
            >
              <Input prefix={<NumberOutlined />} placeholder="e.g., SKU-001" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={6}>
            <Form.Item
              name="roleNumber"
              label="Role Number"
            >
              <Input prefix={<NumberOutlined />} placeholder="Optional" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={6}>
            <Form.Item
              name="productionDate"
              label="Production Date"
              rules={[{ required: true, message: "Select production date" }]}
            >
              <DatePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
            </Form.Item>
          </Col>
        </Row>

        {error && (
          <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />
        )}

        {quantity !== null && !error && (
          <>
            <Divider style={{ margin: "8px 0 16px" }} />
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col xs={12} sm={6}>
                <Statistic
                  title="Quantity"
                  value={quantity}
                  valueStyle={{ color: "#1677ff", fontSize: 28, fontWeight: 700 }}
                  suffix="units"
                />
              </Col>
              <Col xs={24} sm={18}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Serial Numbers Preview
                  </Text>
                  <div style={{ marginTop: 4 }}>
                    {serialPreview.map((s, i) => (
                      <Text
                        key={i}
                        code={s !== "..."}
                        style={{
                          marginRight: 8,
                          fontSize: s === "..." ? 14 : 13,
                        }}
                      >
                        {s}
                      </Text>
                    ))}
                  </div>
                </div>
              </Col>
            </Row>
          </>
        )}

        <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            icon={<PlusOutlined />}
            size="large"
            block
            disabled={quantity === null || !!error}
          >
            Create Batch ({quantity ?? 0} Serial Numbers)
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
