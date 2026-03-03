import BatchForm from "../components/BatchForm";
import GlobalSearch from "../components/GlobalSearch";

export default function CreateBatch() {
  return (
    <>
      <BatchForm />
      <div style={{ marginTop: 24 }}>
        <GlobalSearch />
      </div>
    </>
  );
}
