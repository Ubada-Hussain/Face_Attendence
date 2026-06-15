import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { Bell, CalendarDays, CarFront, Clock3, DoorOpen, RefreshCw, UserCheck } from 'lucide-react';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5050';

function formatTime(value) {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString();
}

function minutesLabel(minutes) {
  const hours = Math.floor((minutes || 0) / 60);
  const mins = Math.round((minutes || 0) % 60);
  return `${hours}h ${mins}m`;
}

function Stat({ icon: Icon, label, value }) {
  return (
    <section className="stat">
      <Icon size={22} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </section>
  );
}

function App() {
  const [dashboard, setDashboard] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  async function loadDashboard() {
    const response = await fetch(`${API_URL}/api/dashboard`);
    setDashboard(await response.json());
    setLoading(false);
  }

  async function loadReport() {
    const response = await fetch(`${API_URL}/api/reports/weekly`);
    setReport(await response.json());
  }

  async function checkAlerts() {
    await fetch(`${API_URL}/api/reports/weekly/check-alerts`, { method: 'POST' });
    await Promise.all([loadDashboard(), loadReport()]);
  }

  async function resetSystem() {
    const confirmed = window.confirm('Reset all active attendance and free all parking slots?');
    if (!confirmed) return;

    await fetch(`${API_URL}/api/admin/reset-system`, { method: 'POST' });
    await Promise.all([loadDashboard(), loadReport()]);
  }

  useEffect(() => {
    loadDashboard();
    loadReport();

    const socket = io(API_URL);
    socket.on('dashboard:update', setDashboard);
    return () => socket.disconnect();
  }, []);

  const activeTeachers = useMemo(() => dashboard?.teachers?.filter((teacher) => teacher.status === 'IN') || [], [dashboard]);

  if (loading) {
    return <main className="loading">Loading attendance monitor...</main>;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p>CA Project</p>
          <h1>Attendance & Parking Monitor</h1>
        </div>
        <div className="headerActions">
          <button className="textButton danger" onClick={resetSystem}>Reset</button>
          <button className="iconButton" onClick={() => Promise.all([loadDashboard(), loadReport()])} title="Refresh">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="statsGrid">
        <Stat icon={UserCheck} label="Currently inside" value={dashboard.totals.activeCount} />
        <Stat icon={CarFront} label="Free parking slots" value={`${dashboard.totals.freeSlots}/${dashboard.totals.totalSlots}`} />
        <Stat icon={Clock3} label="Active sessions" value={activeTeachers.length} />
        <Stat icon={Bell} label="Alerts" value={dashboard.alerts.length} />
      </section>

      <section className="layout">
        <div className="panel">
          <div className="panelHeader">
            <h2>Live Teachers</h2>
            <DoorOpen size={20} />
          </div>
          <div className="teacherList">
            {dashboard.teachers.map((teacher) => (
              <article className="teacherRow" key={teacher._id}>
                <div>
                  <strong>{teacher.name}</strong>
                  <span>{teacher.teacherId} | {teacher.dept}</span>
                </div>
                <div className="rightMeta">
                  <span className={`pill ${teacher.status === 'IN' ? 'in' : 'out'}`}>{teacher.status}</span>
                  <small>Slot {teacher.currentSlot || 'N/A'}</small>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <h2>Parking Slots</h2>
            <CarFront size={20} />
          </div>
          <div className="slotGrid">
            {dashboard.parkingSlots.map((slot) => (
              <article className={`slot ${slot.occupied ? 'busy' : 'free'}`} key={slot._id}>
                <strong>Slot {slot.slotNumber}</strong>
                <span>{slot.occupied ? slot.teacher?.name || 'Occupied' : 'Available'}</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="layout lower">
        <div className="panel">
          <div className="panelHeader">
            <h2>Recent Attendance</h2>
            <CalendarDays size={20} />
          </div>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Duration</th>
                  <th>Slot</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.recentAttendance.map((item) => (
                  <tr key={item._id}>
                    <td>{item.name}</td>
                    <td>{formatTime(item.entryAt)}</td>
                    <td>{formatTime(item.exitAt)}</td>
                    <td>{minutesLabel(item.durationMinutes)}</td>
                    <td>{item.slotNumber || 'N/A'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <h2>Weekly Report</h2>
            <button className="textButton" onClick={checkAlerts}>Check alerts</button>
          </div>
          <div className="reportList">
            {report?.rows?.map((row) => (
              <article className="reportRow" key={row.teacher._id}>
                <div>
                  <strong>{row.teacher.name}</strong>
                  <span>{row.sessions} sessions</span>
                </div>
                <div className="rightMeta">
                  <strong>{row.totalHours}h</strong>
                  <span className={`pill ${row.belowRequired ? 'warn' : 'ok'}`}>
                    {row.belowRequired ? 'Low' : 'OK'}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
