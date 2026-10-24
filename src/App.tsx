import { BrowserRouter, Route, Routes } from 'react-router'
import AppShell from './components/AppShell'
import AuthShield from './components/AuthShield'
import Activity from './pages/Activity'
import Dashboard from './pages/Dashboard'
import GuardDetails from './pages/GuardDetails'
import HowItWorks from './pages/HowItWorks'
import Home from './pages/Home'
import NewGuard from './pages/NewGuard'
import Permissions from './pages/Permissions'
import Positions from './pages/Positions'
import Security from './pages/Security'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/security" element={<Security />} />
        <Route element={<AuthShield />}>
          <Route path="/app" element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="positions" element={<Positions />} />
            <Route path="guards/new" element={<NewGuard />} />
            <Route path="guards/:guardId" element={<GuardDetails />} />
            <Route path="activity" element={<Activity />} />
            <Route path="settings/permissions" element={<Permissions />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}