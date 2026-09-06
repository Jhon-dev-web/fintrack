import 'dotenv/config';
import { createServer } from 'node:http';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import { AI_RATE_LIMIT_MESSAGE, extractTransaction, extractTransactionAudio } from './services/ai.js';

const port = Number(process.env.PORT || 3333);
const jwtSecret = process.env.JWT_SECRET || 'fintrack-development-secret';
const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
console.log('GROQ KEY CARREGADA:', process.env.GROQ_API_KEY ? 'Sim (comprimento: ' + process.env.GROQ_API_KEY.length + ')' : 'NÃO ENCONTRADA');
const TRIAL_DURATION_MS = 3 * 24 * 60 * 60 * 1000;
const TRIAL_EXPIRED_RESPONSE = { error: 'TRIAL_EXPIRED', message: 'Seu período de teste de 3 dias terminou. Faça o upgrade para continuar registrando.' };

const send = (response, status, body) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  response.end(status === 204 ? '' : JSON.stringify(body));
};

const readBody = async (request) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
};

const trialStatus = (user) => {
  const remainingMs = Math.max(0, new Date(user.trialEndsAt).getTime() - Date.now());
  return {
    isPro: user.isPro,
    trialEndsAt: user.trialEndsAt,
    daysRemaining: Math.ceil(remainingMs / (24 * 60 * 60 * 1000)),
    hoursRemaining: Math.ceil(remainingMs / (60 * 60 * 1000)),
    trialExpired: !user.isPro && remainingMs === 0
  };
};
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, ...trialStatus(user) });
const checkAccess = (user) => user.isPro || new Date() < new Date(user.trialEndsAt);
const requireAccess = (user, response) => {
  if (checkAccess(user)) return true;
  send(response, 403, TRIAL_EXPIRED_RESPONSE);
  return false;
};
const issueToken = (user) => jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: '7d' });
const authUser = async (request) => {
  const authorization = request.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return null;
  try {
    const { userId } = jwt.verify(authorization.slice(7), jwtSecret);
    return prisma.user.findUnique({ where: { id: userId } });
  } catch {
    return null;
  }
};
const requireUser = async (request, response) => {
  const user = await authUser(request);
  if (!user) {
    send(response, 401, { error: 'Autenticacao necessaria' });
    return null;
  }
  return user;
};
const toClientTransaction = ({ createdAt, userId, ...transaction }) => transaction;
const parseAudioUpload = (request, response) => new Promise((resolve, reject) => {
  upload.single('audio')(request, response, (error) => error ? reject(error) : resolve(request.file));
});

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (url.pathname === '/api/health') return send(response, 200, { status: 'ok' });

    if (['/register', '/api/register'].includes(url.pathname) && request.method === 'POST') {
      const input = await readBody(request);
      const name = String(input.name || '').trim();
      const email = String(input.email || '').trim().toLowerCase();
      const password = String(input.password || '');
      if (!name || !email || password.length < 6) return send(response, 400, { error: 'Nome, email e senha de no minimo 6 caracteres sao obrigatorios' });
      if (await prisma.user.findUnique({ where: { email } })) return send(response, 409, { error: 'Este email ja esta cadastrado' });
      const user = await prisma.user.create({ data: { name, email, password: await bcrypt.hash(password, 10), trialEndsAt: new Date(Date.now() + TRIAL_DURATION_MS) } });
      return send(response, 201, { token: issueToken(user), user: publicUser(user) });
    }

    if (['/login', '/api/login'].includes(url.pathname) && request.method === 'POST') {
      const input = await readBody(request);
      const email = String(input.email || '').trim().toLowerCase();
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !(await bcrypt.compare(String(input.password || ''), user.password))) return send(response, 401, { error: 'Email ou senha invalidos' });
      return send(response, 200, { token: issueToken(user), user: publicUser(user) });
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      const user = await requireUser(request, response);
      return user ? send(response, 200, { user: publicUser(user) }) : undefined;
    }

    if (url.pathname === '/api/transactions' && request.method === 'GET') {
      const user = await requireUser(request, response);
      if (!user) return;
      const transactions = await prisma.transaction.findMany({ where: { userId: user.id }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
      return send(response, 200, transactions.map(toClientTransaction));
    }

    if (url.pathname === '/api/summary' && request.method === 'GET') {
      const user = await requireUser(request, response);
      if (!user) return;
      const transactions = await prisma.transaction.findMany({ where: { userId: user.id } });
      const income = transactions.filter((item) => item.type === 'income').reduce((total, item) => total + item.amount, 0);
      const expenses = transactions.filter((item) => item.type === 'expense').reduce((total, item) => total + item.amount, 0);
      return send(response, 200, { income, expenses, balance: income - expenses, count: transactions.length });
    }
    if (url.pathname === '/api/transactions/extract' && request.method === 'POST') {
      const user = await requireUser(request, response);
      if (!user) return;
      if (!requireAccess(user, response)) return;
      const input = await readBody(request);
      if (!String(input.text || '').trim()) return send(response, 400, { error: 'Informe uma descricao com valor' });
      try {
        const extracted = await extractTransaction(String(input.text));
        const transaction = await prisma.transaction.create({ data: {
          userId: user.id,
          description: extracted.description.trim(),
          amount: Number(extracted.amount),
          type: extracted.type === 'INCOME' ? 'income' : 'expense',
          category: extracted.category,
          date: extracted.date ? new Date(extracted.date).toISOString() : new Date().toISOString()
        } });
        return send(response, 201, { transactions: [toClientTransaction(transaction)] });
      } catch (error) {
        console.error('Erro na extracao com Gemini:', error);
        if (error?.status === 429) return send(response, 429, { error: AI_RATE_LIMIT_MESSAGE });
        return send(response, 500, { error: 'Nao foi possivel processar a entrada com a IA.' });
      }
    }
    if (url.pathname === '/api/transactions/quick-add' && request.method === 'POST') {
      const user = await requireUser(request, response);
      if (!user) return;
      if (!requireAccess(user, response)) return;
      const input = await readBody(request);
      if (!String(input.text || '').trim()) return send(response, 400, { error: 'Informe uma descricao com valor', message: 'Informe uma descricao com valor.' });
      try {
        const extracted = await extractTransaction(String(input.text));
        const transaction = await prisma.transaction.create({ data: {
          userId: user.id,
          description: extracted.description.trim(),
          amount: Number(extracted.amount),
          type: extracted.type === 'INCOME' ? 'income' : 'expense',
          category: extracted.category,
          date: extracted.date ? new Date(extracted.date).toISOString() : new Date().toISOString()
        } });
        const typeLabel = transaction.type === 'income' ? 'Ganho' : 'Despesa';
        return send(response, 201, { transaction: toClientTransaction(transaction), message: `${typeLabel} adicionado com sucesso!` });
      } catch (error) {
        console.error('Erro no quick-add:', error);
        if (error?.status === 429) return send(response, 429, { error: AI_RATE_LIMIT_MESSAGE, message: AI_RATE_LIMIT_MESSAGE });
        return send(response, 500, { error: 'Nao foi possivel processar o lancamento.', message: 'Nao foi possivel processar o lancamento.' });
      }
    }
    if (url.pathname === '/api/transactions/audio' && request.method === 'POST') {
      const user = await requireUser(request, response);
      if (!user) return;
      if (!requireAccess(user, response)) return;
      const audio = await parseAudioUpload(request, response);
      if (!audio?.buffer) return send(response, 400, { error: 'Envie um arquivo de audio no campo audio' });
      const extractedTransactions = await extractTransactionAudio(audio.buffer, audio.mimetype);
      if (!Array.isArray(extractedTransactions) || extractedTransactions.length === 0) {
        return send(response, 422, { error: 'A IA nao retornou transacoes validas' });
      }
      const transactionData = extractedTransactions.map((extracted) => {
        const normalizedType = String(extracted?.type || '').toUpperCase();
        const amount = Number(extracted?.amount);
        if (!extracted || !String(extracted.description || '').trim() || !Number.isFinite(amount) || amount <= 0 || !['INCOME', 'EXPENSE'].includes(normalizedType)) {
          throw new Error('A IA retornou uma transacao invalida');
        }
        const candidateDate = extracted.date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date) ? new Date(`${extracted.date}T00:00:00.000Z`) : new Date();
        const parsedDate = Number.isNaN(candidateDate.getTime()) ? new Date() : candidateDate;
        return {
          userId: user.id,
          description: extracted.description.trim(),
          amount,
          type: normalizedType === 'INCOME' ? 'income' : 'expense',
          category: String(extracted.category || 'Outros').trim(),
          date: parsedDate.toISOString()
        };
      });
      const transactions = await Promise.all(transactionData.map((data) => prisma.transaction.create({ data })));
      return send(response, 201, { transactions: transactions.map(toClientTransaction) });
    }
    if (url.pathname === '/api/transactions' && request.method === 'POST') {
      const user = await requireUser(request, response);
      if (!user) return;
      if (!requireAccess(user, response)) return;
      const input = await readBody(request);
      if (!input.description || !Number(input.amount) || !['income', 'expense'].includes(input.type)) {
        return send(response, 400, { error: 'description, amount e type sao obrigatorios' });
      }
      const transaction = await prisma.transaction.create({ data: {
        userId: user.id,
        description: String(input.description).trim(),
        amount: Number(input.amount),
        type: input.type,
        category: String(input.category || 'Outros').trim(),
        date: input.date || new Date().toISOString().slice(0, 10)
      } });
      return send(response, 201, toClientTransaction(transaction));
    }
    const transactionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/);
    if (transactionMatch && request.method === 'DELETE') {
      const user = await requireUser(request, response);
      if (!user) return;
      const result = await prisma.transaction.deleteMany({ where: { id: transactionMatch[1], userId: user.id } });
      return result.count ? send(response, 204, {}) : send(response, 404, { error: 'Transacao nao encontrada' });
    }
    return send(response, 404, { error: 'Rota nao encontrada' });
  } catch (error) {
    console.error(error);
    if (error?.status === 429) return send(response, 429, { error: AI_RATE_LIMIT_MESSAGE });
    return send(response, 500, { error: 'Nao foi possivel processar a requisicao' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Fintrack API running on port ${port}`));
