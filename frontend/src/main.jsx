import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App as CapApp } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { ArrowDownLeft, ArrowUpRight, BriefcaseBusiness, CalendarDays, Car, Check, ChevronLeft, ChevronRight, CircleDollarSign, Coffee, Crown, Fuel, HeartPulse, Home, LoaderCircle, LogOut, Mic, Send, ShoppingBag, Sparkles, Square, Trash2, Utensils, WalletCards, X } from 'lucide-react';
import './styles.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => console.error('SW Error:', error));
  });
}

const API_URL = import.meta.env.VITE_API_URL || 'https://capable-adaptation-production-7733.up.railway.app';
const API_ROOT = `${API_URL}/api`;
const AI_RATE_LIMIT_MESSAGE = 'Limite temporário de requisições da IA atingido. Por favor, aguarde 30 segundos e tente novamente.';
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
// selectedMonth é um Date local genuíno (dia 1 do mês exibido), então getters locais são corretos aqui.
const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
// transaction.date é sempre uma string "YYYY-MM-DD" vinda do backend: comparamos a string direto
// para não sofrer o deslocamento de fuso horário que "new Date(dataOnly)" (interpretada como UTC) causa em UTC-3.
const transactionMonthKey = (value) => String(value).slice(0, 7);
const localDateInput = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const formatTransactionDate = (value) => {
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return year && month && day ? `${day}/${month}/${year}` : 'Data indisponível';
};
const transactionIcon = (category, type) => {
  if (type === 'income' || category === 'Trabalho & Renda') return BriefcaseBusiness;
  if (category === 'Alimentação') return Utensils;
  if (category === 'Transporte') return category.toLowerCase().includes('combust') ? Fuel : Car;
  if (category === 'Moradia & Contas') return Home;
  if (category === 'Saúde & Farmácia') return HeartPulse;
  if (category === 'Lazer & Compras') return ShoppingBag;
  return Coffee;
};
function StatCard({ label, value, tone, icon: Icon, format = money.format }) {
  return <article className={`stat-card ${tone}`}><div className="stat-icon"><Icon size={19} /></div><p>{label}</p><strong>{format(value)}</strong></article>;
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('register');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const requestUrl = `${API_ROOT}/${mode === 'register' ? 'register' : 'login'}`;
      console.log('Enviando requisição para:', requestUrl);
      const response = await fetch(requestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Nao foi possivel concluir o acesso');
      localStorage.setItem('fintrack_token', data.token);
      localStorage.setItem('fintrack_user', JSON.stringify(data.user));
      await Preferences.set({ key: 'auth_token', value: data.token });
      onAuthenticated(data.token);
    } catch (submitError) { setError(submitError.message); } finally { setSaving(false); }
  };

  return <main className="auth-shell"><div className="auth-brand"><div className="brand-mark"><WalletCards size={21} /></div><span>fintrack</span></div><section className="auth-card"><div className="auth-intro"><p className="eyebrow">Seu espaço financeiro</p><h1>Clareza para<br /><em>começar bem.</em></h1><p>Crie sua conta e acompanhe suas decisões financeiras em um só lugar.</p></div><div className="auth-form-wrap"><div className="auth-tabs"><button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>Criar conta</button><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Entrar</button></div><form onSubmit={submit}>{mode === 'register' && <label>Nome<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Como podemos te chamar?" /></label>}<label>E-mail<input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="voce@email.com" /></label><label>Senha<input required minLength="6" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Mínimo de 6 caracteres" /></label>{error && <div className="notice">{error}</div>}<button className="submit-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={18} /> : <WalletCards size={18} />}{saving ? 'Aguarde...' : mode === 'register' ? 'Criar minha conta' : 'Entrar no Fintrack'}</button></form></div></section></main>;
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('fintrack_token'));
  const [account, setAccount] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [quickEntry, setQuickEntry] = useState('');
  const [loading, setLoading] = useState(Boolean(token));
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [trialModalOpen, setTrialModalOpen] = useState(false);
  const [transactionModal, setTransactionModal] = useState(null);
  const [deepLinkAction, setDeepLinkAction] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const loadData = async () => {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [transactionResponse, userResponse] = await Promise.all([fetch(`${API_ROOT}/transactions`, { headers }), fetch(`${API_ROOT}/me`, { headers })]);
      if (!transactionResponse.ok || !userResponse.ok) throw new Error('API indisponivel');
      setTransactions(await transactionResponse.json());
      setAccount((await userResponse.json()).user);
      setError('');
    } catch {
      setError('Nao foi possivel conectar ao backend. Inicie a API na porta 3333.');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (token) {
      Preferences.set({ key: 'auth_token', value: token });
      loadData();
    }
  }, [token]);

  useEffect(() => {
    let listener;
    let active = true;
    const handleUrl = (url) => {
      if (url.includes('fintrack://action/voice')) setDeepLinkAction('voice');
      if (url.includes('fintrack://action/expense')) setDeepLinkAction('expense');
      if (url.includes('fintrack://action/income')) setDeepLinkAction('income');
    };
    const registerDeepLinkListener = async () => {
      listener = await CapApp.addListener('appUrlOpen', (event) => handleUrl(event.url));
      const launchUrl = await CapApp.getLaunchUrl();
      if (active && launchUrl?.url) handleUrl(launchUrl.url);
    };
    registerDeepLinkListener();
    return () => {
      active = false;
      listener?.remove();
    };
  }, []);

  const submitQuickEntry = async (event) => {
    event.preventDefault();
    if (!quickEntry.trim()) return;
    if (account?.trialExpired) { setTrialModalOpen(true); return; }
    setSaving(true);
    try {
      const response = await fetch(`${API_ROOT}/transactions/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ text: quickEntry }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403 && data.error === 'TRIAL_EXPIRED') { setTrialModalOpen(true); return; }
        const requestError = new Error(response.status === 429 ? data.error || AI_RATE_LIMIT_MESSAGE : 'Falha ao extrair');
        requestError.status = response.status;
        throw requestError;
      }
      setQuickEntry('');
      await loadData();
    } catch (requestError) { setError(requestError.status === 429 ? requestError.message : 'Nao foi possivel interpretar esta entrada.'); } finally { setSaving(false); }
  };

  const finishAudio = async (blob) => {
    setSaving(true);
    try {
      const body = new FormData();
      body.append('audio', blob, 'fintrack-voice.webm');
      const response = await fetch(`${API_ROOT}/transactions/audio`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403 && data.error === 'TRIAL_EXPIRED') { setTrialModalOpen(true); return; }
        const requestError = new Error(response.status === 429 ? data.error || AI_RATE_LIMIT_MESSAGE : 'Falha ao processar audio');
        requestError.status = response.status;
        throw requestError;
      }
      setFeedback('Transacao registrada por voz.');
      setError('');
      await loadData();
    } catch (requestError) { setError(requestError.status === 429 ? requestError.message : 'Nao foi possivel entender o audio. Tente novamente.'); } finally { setSaving(false); }
  };

  const toggleRecording = async () => {
    if (!recording && account?.trialExpired) { setTrialModalOpen(true); return; }
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Seu navegador nao suporta gravacao de audio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) audioChunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size) await finishAudio(blob);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setFeedback('A ouvir... toque novamente para parar.');
      setError('');
      setRecording(true);
    } catch { setError('Permissao do microfone recusada. Autorize o microfone para registrar por voz.'); }
  };

  const openTransactionModal = (type) => {
    setTransactionModal({ type, description: '', amount: '', category: 'Outros', date: localDateInput() });
  };

  useEffect(() => {
    if (!token || !deepLinkAction) return;
    if (deepLinkAction === 'voice') toggleRecording();
    if (deepLinkAction === 'expense' || deepLinkAction === 'income') openTransactionModal(deepLinkAction);
    setDeepLinkAction('');
  }, [token, deepLinkAction]);

  const submitTransaction = async (event) => {
    event.preventDefault();
    if (!transactionModal) return;
    if (account?.trialExpired) { setTrialModalOpen(true); return; }
    setSaving(true);
    try {
      const response = await fetch(`${API_ROOT}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(transactionModal)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 403 && data.error === 'TRIAL_EXPIRED') { setTrialModalOpen(true); return; }
        throw new Error(data.error || 'Nao foi possivel salvar a transacao.');
      }
      setTransactionModal(null);
      setFeedback('Transacao registrada.');
      setError('');
      await loadData();
    } catch (requestError) { setError(requestError.message); } finally { setSaving(false); }
  };

  const remove = async (id) => {
    await fetch(`${API_ROOT}/transactions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    await loadData();
  };

  const selectedMonthKey = monthKey(selectedMonth);
  const filteredTransactions = transactions.filter((transaction) => transactionMonthKey(transaction.date) === selectedMonthKey);
  const summary = filteredTransactions.reduce((totals, transaction) => {
    if (transaction.type === 'income') totals.income += Number(transaction.amount);
    if (transaction.type === 'expense') totals.expenses += Number(transaction.amount);
    return totals;
  }, { income: 0, expenses: 0 });
  summary.balance = summary.income - summary.expenses;
  const changeMonth = (amount) => setSelectedMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  const accountBadge = !account ? 'Verificando trial...' : account.isPro ? 'Plano Pro' : account.trialExpired ? 'Teste expirado' : account.daysRemaining > 0 ? `Teste Grátis: ${account.daysRemaining} ${account.daysRemaining === 1 ? 'dia' : 'dias'} restantes` : `Teste Grátis: ${account.hoursRemaining} horas restantes`;

  if (!token) return <AuthScreen onAuthenticated={setToken} />;

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><WalletCards size={21} /></div><span>fintrack</span></div><div className="topbar-actions"><div className={`trial-badge ${account?.isPro ? 'pro' : account?.trialExpired ? 'expired' : ''}`}><Crown size={14} /> {accountBadge}</div><div className="period"><CalendarDays size={16} /> {monthName.format(selectedMonth)}</div><button className="logout-button" title="Sair" onClick={() => { localStorage.removeItem('fintrack_token'); localStorage.removeItem('fintrack_user'); Preferences.remove({ key: 'auth_token' }); setToken(null); }}><LogOut size={16} /><span>Sair</span></button></div></header>
      <form className="quick-entry" onSubmit={submitQuickEntry}><div className="quick-entry-heading"><Sparkles size={18} /><div><p className="eyebrow">Registro inteligente</p><h2>O que aconteceu?</h2></div></div><div className="quick-entry-control"><input required value={quickEntry} onChange={(event) => { setQuickEntry(event.target.value); setFeedback(''); }} placeholder="Ex: almoço 35 no débito (uma transação por vez)" aria-label="Descreva suas transacoes" /><button className="quick-entry-button" disabled={saving} title="Enviar entrada rápida">{saving ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}<span>Registrar</span></button><button type="button" className={`microphone-button ${recording ? 'recording' : ''}`} onClick={toggleRecording} disabled={saving} title={recording ? 'Parar gravação' : 'Registrar por voz'} aria-label={recording ? 'Parar gravação' : 'Registrar por voz'}>{recording ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}</button></div>{feedback && <p className={`quick-feedback ${recording ? 'listening' : ''}`}>{feedback}</p>}</form>
    <section className="intro"><div><p className="eyebrow">Visao geral</p><h1>Seu dinheiro,<br /><em>mais claro.</em></h1><p className="subcopy">Acompanhe o que entra, o que sai e o que realmente importa.</p></div><div className="balance-panel"><span>Saldo disponivel</span><strong>{money.format(summary.balance)}</strong><small><Check size={14} /> atualizado agora</small></div></section>
    {error && <div className="notice" role="alert">{error}</div>}
    <div className="month-selector" aria-label="Filtrar transações por mês"><button type="button" onClick={() => changeMonth(-1)} aria-label="Mês anterior" title="Mês anterior"><ChevronLeft size={20} /></button><strong>{monthName.format(selectedMonth)}</strong><button type="button" onClick={() => changeMonth(1)} aria-label="Próximo mês" title="Próximo mês"><ChevronRight size={20} /></button></div>
    <section className="stats"><StatCard label="Entradas" value={summary.income} tone="income" icon={ArrowDownLeft} /><StatCard label="Saidas" value={summary.expenses} tone="expense" icon={ArrowUpRight} /><StatCard label="Transacoes" value={filteredTransactions.length} tone="neutral" icon={CircleDollarSign} format={(value) => `${value} ${value === 1 ? 'transação' : 'transações'}`} /></section>
    <section className="workspace">
      <div className="transactions-panel"><div className="section-heading"><div><p className="eyebrow">Atividade recente</p><h2>Transacoes</h2></div><span className="count">{filteredTransactions.length} registros</span></div>
        {loading ? <div className="empty"><LoaderCircle className="spin" /> Carregando...</div> : filteredTransactions.length === 0 ? <div className="empty">Nenhuma transacao neste mes.</div> : <div className="transaction-list" style={{ width: '100%', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: '10px', boxSizing: 'border-box' }}>
          {filteredTransactions.map((transaction) => {
            const Icon = transactionIcon(transaction.category, transaction.type);
            const isIncome = transaction.type === 'income';

            return (
              <article
                key={transaction.id}
                style={{
                  width: '100%',
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                  backgroundColor: '#FFFFFF',
                  borderRadius: '16px',
                  padding: '12px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                  overflow: 'hidden'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      width: '38px',
                      height: '38px',
                      borderRadius: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      backgroundColor: isIncome ? '#E6F4EA' : '#FCE8E6',
                      color: isIncome ? '#137333' : '#C5221F'
                    }}
                  >
                    <Icon size={18} />
                  </div>

                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong
                      style={{
                        display: 'block',
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        color: '#202124',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                      title={transaction.description}
                    >
                      {transaction.description}
                    </strong>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '0.72rem',
                        color: '#70757a',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      <span>{transaction.category}</span>
                      <span style={{ margin: '0 4px' }}>·</span>
                      <span>{formatTransactionDate(transaction.date)}</span>
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <strong
                    style={{
                      fontSize: '0.875rem',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      color: isIncome ? '#137333' : '#C5221F',
                      textAlign: 'right'
                    }}
                  >
                    {isIncome ? '+' : '-'} {money.format(transaction.amount)}
                  </strong>

                  <button
                    type="button"
                    title="Excluir transacao"
                    aria-label={`Excluir ${transaction.description}`}
                    onClick={() => remove(transaction.id)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '6px',
                      cursor: 'pointer',
                      color: '#9aa0a6',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      borderRadius: '8px'
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>}
      </div>
    </section><footer>Fintrack · Controle simples para decisoes melhores</footer>
    {transactionModal && <div className="modal-backdrop" role="presentation" onClick={() => setTransactionModal(null)}><section className="transaction-modal" role="dialog" aria-modal="true" aria-labelledby="transaction-modal-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setTransactionModal(null)} aria-label="Fechar"><X size={18} /></button><p className="eyebrow">Novo registro</p><h2 id="transaction-modal-title">{transactionModal.type === 'expense' ? 'Adicionar despesa' : 'Adicionar ganho'}</h2><form onSubmit={submitTransaction}><label>Descrição<input required autoFocus value={transactionModal.description} onChange={(event) => setTransactionModal({ ...transactionModal, description: event.target.value })} placeholder={transactionModal.type === 'expense' ? 'Ex: almoço' : 'Ex: salário'} /></label><label>Valor<input required min="0.01" step="0.01" type="number" inputMode="decimal" value={transactionModal.amount} onChange={(event) => setTransactionModal({ ...transactionModal, amount: event.target.value })} placeholder="0,00" /></label><label>Categoria<input value={transactionModal.category} onChange={(event) => setTransactionModal({ ...transactionModal, category: event.target.value })} /></label><label>Data<input required type="date" value={transactionModal.date} onChange={(event) => setTransactionModal({ ...transactionModal, date: event.target.value })} /></label><button className={`transaction-submit ${transactionModal.type}`} type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />} {saving ? 'Salvando...' : 'Salvar registro'}</button></form></section></div>}
    {trialModalOpen && <div className="modal-backdrop" role="presentation" onClick={() => setTrialModalOpen(false)}><section className="trial-modal" role="dialog" aria-modal="true" aria-labelledby="trial-modal-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setTrialModalOpen(false)} aria-label="Fechar"><X size={18} /></button><div className="modal-icon"><Crown size={24} /></div><p className="eyebrow">Acesso FinTrack</p><h2 id="trial-modal-title">Seu teste gratuito de 3 dias terminou!</h2><p>Desbloqueie o acesso ilimitado com o plano Pro.</p><button className="upgrade-button" type="button" onClick={() => window.alert('Em breve disponível na Google Play!')}>Assinar via Google Play</button></section></div>}
  </main>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
