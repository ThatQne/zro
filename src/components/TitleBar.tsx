import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { Minus, Square, X } from "lucide-react";
import logo from "../../logo.png";

export default function TitleBar() {
  return (
    <div
      className="flex items-center justify-between px-3 drag-region no-select"
      style={{ height: 40, background: "#0c0c0c", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
    >
      <div className="flex items-center gap-2 no-drag">
        <img src={logo} alt="" style={{ width: 16, height: 16, borderRadius: 4 }} draggable={false} />
        <span
          className="text-xs font-semibold"
          style={{ color: "#e4e4e4", letterSpacing: "0.2em" }}
        >
          zro
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-0.5 no-drag">
        <WinBtn icon={<Minus size={12} />} onClick={() => invoke("minimize_window")} title="Minimize" />
        <WinBtn icon={<Square size={10} />} onClick={() => invoke("maximize_window")} title="Maximize" />
        <WinBtn icon={<X size={12} />} onClick={() => invoke("close_window")} title="Close" danger />
      </div>
    </div>
  );
}

interface WinBtnProps {
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}

function WinBtn({ icon, onClick, title, danger }: WinBtnProps) {
  return (
    <motion.button
      onClick={onClick}
      title={title}
      whileHover={{
        backgroundColor: danger ? "rgba(220,50,50,0.8)" : "rgba(255,255,255,0.09)",
        color: "#e4e4e4",
      }}
      whileTap={{ scale: 0.9 }}
      transition={{ duration: 0.1 }}
      style={{
        width: 30,
        height: 22,
        color: "#484848",
        background: "transparent",
        border: "none",
        cursor: "default",
        borderRadius: 5,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon}
    </motion.button>
  );
}
