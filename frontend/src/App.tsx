import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { Layout, Menu, Typography, theme } from "antd";
import { PlusCircleOutlined, UnorderedListOutlined } from "@ant-design/icons";
import CreateBatch from "./pages/CreateBatch";
import BatchRecords from "./pages/BatchRecords";

const { Header, Content } = Layout;
const { Title } = Typography;

function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  const selectedKey = location.pathname === "/records" ? "records" : "create";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          background: colorBgContainer,
          borderBottom: "1px solid #f0f0f0",
          padding: "0 24px",
          gap: 24,
        }}
      >
        <Title level={4} style={{ margin: 0, whiteSpace: "nowrap" }}>
          Plant Management
        </Title>
        <Menu
          mode="horizontal"
          selectedKeys={[selectedKey]}
          onClick={({ key }) => navigate(key === "create" ? "/" : "/records")}
          style={{ flex: 1, borderBottom: "none" }}
          items={[
            {
              key: "create",
              icon: <PlusCircleOutlined />,
              label: "Create Batch",
            },
            {
              key: "records",
              icon: <UnorderedListOutlined />,
              label: "Batch Records",
            },
          ]}
        />
      </Header>

      <Content style={{ padding: "24px", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        <Routes>
          <Route path="/" element={<CreateBatch />} />
          <Route path="/records" element={<BatchRecords />} />
        </Routes>
      </Content>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}
