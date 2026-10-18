
import React from 'react';
import { AuthProvider } from './context/AuthContext';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import IntelligenceDashboard from './components/IntelligenceDashboard';
import ReportViewer from './components/ReportViewer';
import PrivacyPolicy from './pages/legal/PrivacyPolicy';
import TermsOfService from './pages/legal/TermsOfService';

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          {/* Founder Routes */}
          <Route path="/" element={<IntelligenceDashboard />} />
          <Route path="/report/:shareToken" element={<ReportViewer />} />
          <Route path="/company/:companySlug" element={<ReportViewer />} />
          <Route path="/legal/privacy" element={<PrivacyPolicy />} />
          <Route path="/legal/terms" element={<TermsOfService />} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
      <Toaster 
        position="bottom-right" 
        toastOptions={{
          style: {
            background: 'var(--bah-panel-strong)',
            color: 'var(--bah-text)',
            border: '1px solid var(--bah-border)',
          },
          success: {
            iconTheme: {
              primary: 'var(--bah-accent)',
              secondary: 'var(--bah-panel-strong)',
            },
          },
          error: {
            iconTheme: {
              primary: 'var(--bah-danger)',
              secondary: 'var(--bah-panel-strong)',
            },
          },
        }}
      />
    </AuthProvider>
  );
}
