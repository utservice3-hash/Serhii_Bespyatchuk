import { createRoot } from "react-dom/client";
import { ReactivationSection } from "./pages/dashboard/sections/ReactivationSection";
const auth = (window as any).__AUTH__;
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 18, background: "#f1f5f9", minHeight: "100vh" }}>
    <ReactivationSection auth={auth} />
  </div>
);
(window as any).__ready = true;
