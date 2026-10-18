
import React from 'react';
import { AuthProvider } from './context/AuthContext';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import AdminLayout from './components/AdminLayout';
import ProtectedRoute from './components/ProtectedRoute';
import AdminLogin from './pages/admin/AdminLogin';
import AdminResetPassword from './pages/admin/AdminResetPassword';
import AdminDashboard from './pages/admin/AdminDashboard';
import IntelligenceDashboard from './components/IntelligenceDashboard';
import ReportViewer from './components/ReportViewer';
import PrivacyPolicy from './pages/legal/PrivacyPolicy';
import TermsOfService from './pages/legal/TermsOfService';
import ClientList from './pages/admin/ClientList';
import ClientDetail from './pages/admin/ClientDetail';
import SystemHealth from './pages/admin/SystemHealth';
import ComingSoon from './components/Admin/ComingSoon';

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

          {/* Admin Auth - Password-based (founders use magic link on `/`) */}
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin/reset" element={<AdminResetPassword />} />

          {/* Admin Routes - Protected */}
          <Route path="/admin" element={
            <ProtectedRoute role="admin">
              <AdminLayout />
            </ProtectedRoute>
          }>
            <Route index element={<AdminDashboard />} />
            {/* Future routes: /admin/clients, /admin/users etc. */}
            <Route path="clients" element={<ClientList />} />
            <Route path="clients/:clientId" element={<ClientDetail />} />
            <Route path="reports" element={<ComingSoon title="Reports & Analytics" description="Comprehensive platform usage reports and capability metrics are currently under development." />} />
            <Route path="health" element={<SystemHealth />} />
            <Route path="settings" element={<ComingSoon title="Platform Settings" description="Global platform configuration and security controls will be available soon." />} />
          </Route>

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
