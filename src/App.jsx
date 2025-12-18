import React, { useState } from "react";
import CoreGame from "./CoreGame";
import OnlineGame from "./online/OnlineGame";
import "./App.css";

export default function App() {
  const [tab, setTab] = useState("core"); // "core" | "online"

  return (
    <div style={{ minHeight: "100vh" }}>
      <div style={{ display: "flex", justifyContent: "center", gap: 10, padding: 12 }}>
        <button
          className="control-btn"
          onClick={() => setTab("core")}
          style={{ opacity: tab === "core" ? 1 : 0.7 }}
        >
          Core Game
        </button>
        <button
          className="control-btn"
          onClick={() => setTab("online")}
          style={{ opacity: tab === "online" ? 1 : 0.7 }}
        >
          Online Game
        </button>
      </div>

      {tab === "core" ? <CoreGame /> : <OnlineGame />}
    </div>
  );
}
