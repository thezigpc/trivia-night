import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { basePath, ErrorBoundary, OnScreenKeyboard, VenueAnnouncement } from "@bargames/gamekit/client";
import { AdminPage } from "./pages/AdminPage";
import { HomePage } from "./pages/HomePage";
import { HostPage } from "./pages/HostPage";
import { RoomPage } from "./pages/RoomPage";
import { useVenue } from "./useVenue";
import "./index.css";

/**
 * Bar Games: keeps the venue theme applied, and shows the staff's announcement on every
 * page. It hides itself on screens marked as TVs (the SDK's tableMode / markSharedScreen),
 * and follows the staff's "show" (phones / TVs / everywhere) and top/bottom. Off a box it
 * renders nothing.
 */
function Venue() {
  const venue = useVenue();
  return <VenueAnnouncement ctx={venue} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter basename={basePath()}>
        <Venue />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/join/:code" element={<HomePage />} />
          <Route path="/host" element={<HostPage />} />
          <Route path="/room/:code" element={<RoomPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      {/* GameKit 0.10.0: big keys under a focused field on a touchscreen with no keyboard of its
          own (box 0.21.0's touch screens). Hidden on phones, tablets and PCs. One app covers
          every page: join, host setup, console, TV and admin. */}
      <OnScreenKeyboard />
    </ErrorBoundary>
  </React.StrictMode>,
);
