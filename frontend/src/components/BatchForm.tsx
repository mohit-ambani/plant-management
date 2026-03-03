import { useState, useCallback } from "react";
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
  Tag,
} from "antd";
import {
  PlusOutlined,
  NumberOutlined,
  BarcodeOutlined,
  TagOutlined,
  MinusCircleOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { createBatch } from "../services/api";

const { Text } = Typography;

interface RangeInfo {
  startSerial: string;
  endSerial: string;
  prefix: string;
  startNum: number;
  endNum: number;
  width: number;
  quantity: number;
  preview: string[];
  error: string | null;
}

function parseSerial(serial: string): { prefix: string; number: number; width: number } | null {
  const match = serial.match(/^([A-Za-z])(\d+)$/);
  if (!match) return null;
  return { prefix: match[1].toUpperCase(), number: parseInt(match[2], 10), width: match[2].length };
}

function computeRange(startSerial: string, endSerial: string): RangeInfo | null {
  if (!startSerial && !endSerial) return null;

  const result: RangeInfo = {
    startSerial,
    endSerial,
    prefix: "",
    startNum: 0,
    endNum: 0,
    width: 0,
    quantity: 0,
    preview: [],
    error: null,
  };

  if (!startSerial || !endSerial) {
    result.error = "Both start and end serial are required";
    return result;
  }

  const start = parseSerial(startSerial);
  const end = parseSerial(endSerial);

  if (!start || !end) {
    result.error = "Invalid format. Use letter + digits (e.g., A100)";
    return result;
  }

  if (start.prefix !== end.prefix) {
    result.error = "Prefix mismatch";
    return result;
  }

  if (end.number <= start.number) {
    result.error = "End must be greater than start";
    return result;
  }

  const qty = end.number - start.number;
  const width = Math.max(start.width, end.width);
  const prefix = start.prefix;

  const preview: string[] = [];
  if (qty <= 5) {
    for (let i = start.number + 1; i <= end.number; i++) {
      preview.push(`${prefix}${String(i).padStart(width, "0")}`);
    }
  } else {
    preview.push(`${prefix}${String(start.number + 1).padStart(width, "0")}`);
    preview.push(`${prefix}${String(start.number + 2).padStart(width, "0")}`);
    preview.push("...");
    preview.push(`${prefix}${String(end.number).padStart(width, "0")}`);
  }

  return {
    ...result,
    prefix,
    startNum: start.number,
    endNum: end.number,
    width,
    quantity: qty,
    preview,
    error: null,
  };
}

export default function BatchForm() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [rangeInfos, setRangeInfos] = useState<(RangeInfo | null)[]>([null]);

  const recalculate = useCallback(() => {
    setTimeout(() => {
      const ranges = form.getFieldValue("ranges") || [];
      const infos = ranges.map((r: any) =>
        r ? computeRange(r.startSerial || "", r.endSerial || "") : null
      );
      setRangeInfos(infos);
    }, 0);
  }, [form]);

  const totalQuantity = rangeInfos.reduce(
    (sum, r) => sum + (r && !r.error ? r.quantity : 0),
    0
  );

  const hasErrors = rangeInfos.some((r) => r?.error);
  const hasValidRange = rangeInfos.some((r) => r && !r.error && r.quantity > 0);

  const handleSubmit = async (values: any) => {
    const ranges = (values.ranges || [])
      .filter((r: any) => r?.startSerial && r?.endSerial)
      .map((r: any) => ({
        startSerial: r.startSerial,
        endSerial: r.endSerial,
      }));

    if (ranges.length === 0) {
      message.error("Add at least one serial number range");
      return;
    }

    setLoading(true);
    try {
      const res = await createBatch({
        ranges,
        batchCode: values.batchCode,
        skuId: values.skuId,
        productionDate: values.productionDate.format("YYYY-MM-DD"),
        roleNumber: values.roleNumber || undefined,
      });
      const extApi = res.data.externalApi;
      if (extApi?.success) {
        message.success(`Batch created with ${totalQuantity} serial numbers. External API: success.`);
      } else {
        message.success(`Batch created with ${totalQuantity} serial numbers.`);
        if (extApi) {
          message.warning(`External API: ${extApi.response}`, 6);
        }
      }
      form.resetFields();
      setRangeInfos([null]);
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
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        size="large"
        initialValues={{
          productionDate: dayjs(),
          skuId: "Sku2",
          ranges: [{ startSerial: "", endSerial: "" }],
        }}
      >
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
            <Form.Item name="roleNumber" label="Role Number">
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

        <Divider orientation="left" plain style={{ margin: "4px 0 16px" }}>
          Serial Number Ranges
        </Divider>

        <Form.List name="ranges">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }, index) => {
                const info = rangeInfos[index];
                return (
                  <div key={key} style={{ marginBottom: 12 }}>
                    <Row gutter={12} align="middle">
                      <Col xs={24} sm={7}>
                        <Form.Item
                          {...restField}
                          name={[name, "startSerial"]}
                          rules={[
                            { required: true, message: "Start serial" },
                            {
                              pattern: /^[A-Za-z]\d+$/,
                              message: "e.g., A100",
                            },
                          ]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input
                            prefix={<BarcodeOutlined />}
                            placeholder="Start (e.g., A1)"
                            onChange={recalculate}
                          />
                        </Form.Item>
                      </Col>
                      <Col
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "0 4px",
                        }}
                      >
                        <Text type="secondary">to</Text>
                      </Col>
                      <Col xs={24} sm={7}>
                        <Form.Item
                          {...restField}
                          name={[name, "endSerial"]}
                          rules={[
                            { required: true, message: "End serial" },
                            {
                              pattern: /^[A-Za-z]\d+$/,
                              message: "e.g., A100",
                            },
                          ]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input
                            prefix={<BarcodeOutlined />}
                            placeholder="End (e.g., A1000)"
                            onChange={recalculate}
                          />
                        </Form.Item>
                      </Col>
                      <Col flex="auto" style={{ minWidth: 0 }}>
                        {info && !info.error && info.quantity > 0 && (
                          <Space size={4} wrap>
                            <Tag color="blue">{info.quantity.toLocaleString()} units</Tag>
                            {info.preview.map((s, i) => (
                              <Text
                                key={i}
                                code={s !== "..."}
                                style={{ fontSize: 12 }}
                              >
                                {s}
                              </Text>
                            ))}
                          </Space>
                        )}
                        {info?.error && (
                          <Text type="danger" style={{ fontSize: 12 }}>
                            {info.error}
                          </Text>
                        )}
                      </Col>
                      <Col>
                        {fields.length > 1 && (
                          <Button
                            type="text"
                            danger
                            icon={<MinusCircleOutlined />}
                            onClick={() => {
                              remove(name);
                              setTimeout(recalculate, 0);
                            }}
                          />
                        )}
                      </Col>
                    </Row>
                  </div>
                );
              })}
              <Form.Item style={{ marginBottom: 16 }}>
                <Button
                  type="dashed"
                  onClick={() => {
                    add({ startSerial: "", endSerial: "" });
                    setRangeInfos((prev) => [...prev, null]);
                  }}
                  block
                  icon={<PlusOutlined />}
                >
                  Add Another Range
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>

        {hasValidRange && !hasErrors && (
          <Row style={{ marginBottom: 16 }}>
            <Col>
              <Statistic
                title="Total Quantity (all ranges)"
                value={totalQuantity}
                valueStyle={{ color: "#1677ff", fontSize: 28, fontWeight: 700 }}
                suffix="units"
              />
            </Col>
          </Row>
        )}

        <Form.Item style={{ marginBottom: 0 }}>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            icon={<PlusOutlined />}
            size="large"
            block
            disabled={!hasValidRange || hasErrors}
          >
            Create Batch ({totalQuantity.toLocaleString()} Serial Numbers)
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
