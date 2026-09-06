import { GoogleGenAI, Type } from '@google/genai';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk/uploads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const apiKey = (process.env.GROQ_API_KEY || '').trim();
const groq = new Groq({ apiKey });
console.log('[Groq] Inicializando com chave:', apiKey ? `${apiKey.substring(0, 7)}... (tamanho: ${apiKey.length})` : 'NÃO ENCONTRADA');

const transactionSchema = {
  type: Type.OBJECT,
  properties: {
    description: {
      type: Type.STRING,
      description: 'Nome limpo do gasto ou receita, sem valores ou formas de pagamento.'
    },
    amount: {
      type: Type.NUMBER,
      description: 'Valor numerico positivo da transacao.'
    },
    type: {
      type: Type.STRING,
      enum: ['EXPENSE', 'INCOME']
    },
    category: {
      type: Type.STRING,
      enum: ['Alimentação', 'Transporte', 'Moradia & Contas', 'Saúde & Farmácia', 'Lazer & Compras', 'Trabalho & Renda', 'Outros']
    },
    date: {
      type: Type.STRING,
      description: 'Data no formato YYYY-MM-DD.'
    }
  },
  required: ['description', 'amount', 'type', 'category', 'date'],
  propertyOrdering: ['description', 'amount', 'type', 'category', 'date']
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const is503 = (error) => error?.status === 503 || error?.statusCode === 503 || error?.code === 503 || /\b503\b|unavailable|overloaded/i.test(error?.message || '');
const is429 = (error) => error?.status === 429 || error?.statusCode === 429 || error?.code === 429 || /\b429\b|resource_exhausted|rate limit|quota/i.test(error?.message || '');
const isTimeout = (error) => error?.code === 'ETIMEDOUT' || error?.name === 'AbortError' || /timeout|timed out/i.test(error?.message || '');
export const AI_RATE_LIMIT_MESSAGE = 'Limite temporário de requisições da IA atingido. Por favor, aguarde 30 segundos e tente novamente.';
const rateLimitError = () => Object.assign(new Error(AI_RATE_LIMIT_MESSAGE), { status: 429 });

const generateWithTimeout = (contents) => Promise.race([
  ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents,
    config: {
      responseMimeType: 'application/json',
      responseSchema: transactionSchema,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
      systemInstruction: `Você é um classificador financeiro de alta precisão especializado em gírias, contrações e vocabulário brasileiro.

Categorias permitidas:
- Alimentação: supermercado, padaria, espetinho, açaí, restaurante, delivery, lanche, café, bar, sorvete.
- Transporte: uber, 99, corrida, combustível, gasolina, etanol, ônibus, estacionamento, pedágio.
- Moradia & Contas: energia, luz, água, gás, condomínio, internet, aluguel, manutenção da casa.
- Saúde & Farmácia: remédio, farmácia, drogaria, consulta, exames, dentista.
- Lazer & Compras: cinema, roupas, jogos, assinaturas, passeios, eletrônicos.
- Trabalho & Renda: salário, comissão, freelance, freela, serviço prestado, bico, vendas, honorários.
- Outros: apenas se for impossível inferir contexto financeiro.

Regra prioritária de contexto financeiro brasileiro: termos que representam trabalho realizado, prestação de serviços ou remuneração DEVEM ser classificados como INCOME e category "Trabalho & Renda", exceto quando o usuário disser explicitamente que pagou ou contratou outra pessoa. Só classifique como EXPENSE nesses casos quando houver contexto claro de contratação ou pagamento feito a terceiros, como "paguei o mecânico", "conserto do carro" ou "diária do pedreiro que paguei".

Regra geral: EXPENSE é qualquer saída, pagamento de conta, compra ou consumo. INCOME são salários, serviços prestados, rendimentos, vendas, pagamentos recebidos, reembolsos ou "caiu pix".

Few-shot obrigatórios de classificação:
- 'serviço 250' -> {"description":"Serviço","amount":250,"type":"INCOME","category":"Trabalho & Renda"}
- 'bico 100' -> {"description":"Bico","amount":100,"type":"INCOME","category":"Trabalho & Renda"}
- 'diária 150' -> {"description":"Diária","amount":150,"type":"INCOME","category":"Trabalho & Renda"}
- 'freela 400' -> {"description":"Freela","amount":400,"type":"INCOME","category":"Trabalho & Renda"}
- 'comissão 80' -> {"description":"Comissão","amount":80,"type":"INCOME","category":"Trabalho & Renda"}
- 'salário' -> {"description":"Salário","type":"INCOME","category":"Trabalho & Renda"}
- 'adiantamento' -> {"description":"Adiantamento","type":"INCOME","category":"Trabalho & Renda"}
- 'pagamento caiu' -> {"description":"Pagamento recebido","type":"INCOME","category":"Trabalho & Renda"}
- 'recebi 300 do freela' -> {"description":"Freela","amount":300,"type":"INCOME","category":"Trabalho & Renda"}
- 'vendi 200' -> {"description":"Venda","amount":200,"type":"INCOME","category":"Trabalho & Renda"}
- 'entrou 100' -> {"description":"Entrada","amount":100,"type":"INCOME","category":"Trabalho & Renda"}
- 'ganhei 50' -> {"description":"Entrada","amount":50,"type":"INCOME","category":"Trabalho & Renda"}
- 'pix de fulano 75' -> {"description":"Pix recebido","amount":75,"type":"INCOME","category":"Trabalho & Renda"}
- 'paguei o mecânico 250' -> {"description":"Mecânico","amount":250,"type":"EXPENSE","category":"Moradia & Contas"}
- 'conserto do carro 300' -> {"description":"Conserto do carro","amount":300,"type":"EXPENSE","category":"Transporte"}
- 'diária do pedreiro que paguei 150' -> {"description":"Diária do pedreiro","amount":150,"type":"EXPENSE","category":"Moradia & Contas"}

Outros exemplos:
- 'espetinho 25' -> description: 'Espetinho', amount: 25, type: 'EXPENSE', category: 'Alimentação'
- 'sorvete 30' -> description: 'Sorvete', amount: 30, type: 'EXPENSE', category: 'Alimentação'
- 'energia 250' -> description: 'Conta de Energia', amount: 250, type: 'EXPENSE', category: 'Moradia & Contas'
- 'serviço de solda 400' -> description: 'Serviço prestado', amount: 400, type: 'INCOME', category: 'Trabalho & Renda'
- 'gasosa 50 no débito' -> description: 'Combustível', amount: 50, type: 'EXPENSE', category: 'Transporte'

Extraia sempre a descrição limpa e padronizada, sem números soltos ou termos de pagamento. Use a data atual no formato YYYY-MM-DD quando não houver data explícita.`
    }
  }),
  new Promise((_, reject) => setTimeout(() => {
    const error = new Error('Gemini request timed out');
    error.code = 'ETIMEDOUT';
    reject(error);
  }, 8000))
]);

const normalize = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const localExtract = (text) => {
  const amountMatches = [...text.matchAll(/(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/gi)];
  const amountMatch = amountMatches.at(-1);
  const amount = amountMatch ? Number(amountMatch[1].replace(',', '.')) : 0;
  const normalizedText = normalize(text);
  const type = /salario|sallario|adiantamento|vale|extra|renda extra|bico|freela|freelance|servico|honorarios|cliente|venda|comissao|recebi|caiu pix|deposito|reembolso|rendimento|entrada|ganhei/.test(normalizedText) ? 'INCOME' : 'EXPENSE';
  const category = /uber|\b99\b|corrida|combustivel|gasolina|etanol|gasosa|onibus|estacionamento|pedagio/.test(normalizedText) ? 'Transporte'
    : /supermercado|almoco|jantar|lanche|padaria|mercado|restaurante|espetinho|sorvete|pizza|acai|delivery|cafe|bar/.test(normalizedText) ? 'Alimentação'
      : /aluguel|energia|luz|agua|gas|condominio|internet|manutencao/.test(normalizedText) ? 'Moradia & Contas'
        : /remedio|farmacia|drogaria|consulta|exames|dentista/.test(normalizedText) ? 'Saúde & Farmácia'
          : /cinema|roupas|jogos|assinaturas|passeios|eletronicos/.test(normalizedText) ? 'Lazer & Compras'
            : /salario|sallario|adiantamento|vale|extra|renda extra|bico|freela|freelance|servico|honorarios|cliente|venda|vendas|comissao|recebi|deposito|reembolso|rendimento/.test(normalizedText) ? 'Trabalho & Renda'
              : 'Outros';
  const cleanedDescription = text
    .replace(amountMatch?.[0] || '', '')
    .replace(/\b(reais?|conto|pila)\b/gi, '')
    .replace(/\b(?:no|na|em)\s+(?:d[eé]bito|cr[eé]dito|pix|cart[aã]o|dinheiro)\b/gi, '')
    .replace(/\b(?:um|uma|de|do|da|no|na|em|por)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,.;:-]+|[,.;:-]+$/g, '')
    .trim();
  const description = /\bextra\b|renda extra|\bbico\b/i.test(normalizedText) ? 'Renda Extra'
    : /\bservi[cç]o\b/i.test(text) ? 'Serviço prestado'
      : /\benergia\b/i.test(normalizedText) ? 'Conta de Energia'
        : /\bgasosa\b/i.test(normalizedText) ? 'Combustível'
      : cleanedDescription;
  return {
    description: description ? description.charAt(0).toUpperCase() + description.slice(1) : 'Transacao',
    amount,
    type,
    category,
    date: new Date().toISOString().slice(0, 10)
  };
};

export const extractTransaction = async (text) => {
  const contents = `Classifique esta entrada financeira em português e retorne somente o JSON do schema: "${text}"`;
  try {
    if (!process.env.GEMINI_API_KEY) return localExtract(text);
    let response;
    try {
      response = await generateWithTimeout(contents);
    } catch (error) {
      if (!is503(error)) throw error;
      await wait(800);
      response = await generateWithTimeout(contents);
    }
    return JSON.parse(response.text);
  } catch (error) {
    if (is429(error)) throw rateLimitError();
    if (is503(error) || isTimeout(error)) return localExtract(text);
    return localExtract(text);
  }
};

export const extractTransactionAudio = async (buffer, mimeType) => {
  if (typeof process.env.GROQ_API_KEY !== 'string' || !process.env.GROQ_API_KEY.trim()) {
    throw new Error('GROQ_API_KEY nao configurada. Defina a chave no arquivo backend/.env e reinicie o backend.');
  }
  try {
    const file = await toFile(buffer, 'audio.m4a', { type: mimeType });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      language: 'pt',
      response_format: 'text'
    });
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: `Você é um classificador financeiro estrito para o público brasileiro. Retorne SEMPRE EXCLUSIVAMENTE um array JSON de objetos neste formato:
[
  {
    "description": "Lanche da tarde",
    "amount": 25.50,
    "type": "expense",
    "category": "Alimentação",
    "date": "YYYY-MM-DD"
  }
]
Se o usuário mencionar mais de um item, gasto ou valor no mesmo áudio, NÃO SOME. Retorne um objeto separado para cada gasto identificado, com sua respectiva categoria, valor, descrição e data.
Use somente os valores "income" ou "expense" no campo type. Regra prioritária de contexto financeiro brasileiro: termos que representam trabalho realizado, prestação de serviços ou remuneração DEVEM ser income e category "Trabalho & Renda", exceto quando o usuário disser explicitamente que pagou ou contratou outra pessoa. Só use expense quando houver contexto claro de contratação ou pagamento feito a terceiros, como "paguei o mecânico", "conserto do carro" ou "diária do pedreiro que paguei".
Few-shot obrigatórios:
- 'serviço 250' -> {"description":"Serviço","amount":250,"type":"INCOME","category":"Trabalho & Renda"}
- 'bico 100' -> {"description":"Bico","amount":100,"type":"INCOME","category":"Trabalho & Renda"}
- 'diária 150' -> {"description":"Diária","amount":150,"type":"INCOME","category":"Trabalho & Renda"}
- 'freela 400' -> {"description":"Freela","amount":400,"type":"INCOME","category":"Trabalho & Renda"}
- 'comissão 80' -> {"description":"Comissão","amount":80,"type":"INCOME","category":"Trabalho & Renda"}
- 'salário' -> {"description":"Salário","type":"INCOME","category":"Trabalho & Renda"}
- 'adiantamento' -> {"description":"Adiantamento","type":"INCOME","category":"Trabalho & Renda"}
- 'pagamento caiu' -> {"description":"Pagamento recebido","type":"INCOME","category":"Trabalho & Renda"}
- 'recebi 300 do freela' -> {"description":"Freela","amount":300,"type":"INCOME","category":"Trabalho & Renda"}
- 'vendi 200' -> {"description":"Venda","amount":200,"type":"INCOME","category":"Trabalho & Renda"}
- 'entrou 100' -> {"description":"Entrada","amount":100,"type":"INCOME","category":"Trabalho & Renda"}
- 'ganhei 50' -> {"description":"Entrada","amount":50,"type":"INCOME","category":"Trabalho & Renda"}
- 'pix de fulano 75' -> {"description":"Pix recebido","amount":75,"type":"INCOME","category":"Trabalho & Renda"}
- 'paguei o mecânico 250' -> {"description":"Mecânico","amount":250,"type":"EXPENSE","category":"Moradia & Contas"}
- 'conserto do carro 300' -> {"description":"Conserto do carro","amount":300,"type":"EXPENSE","category":"Transporte"}
- 'diária do pedreiro que paguei 150' -> {"description":"Diária do pedreiro","amount":150,"type":"EXPENSE","category":"Moradia & Contas"}
Outros exemplos:
- 'almoço 25 reais no débito' -> {"description":"Almoço","amount":25,"type":"EXPENSE","category":"Alimentação"}
- 'gasosa 50' -> {"description":"Combustível","amount":50,"type":"EXPENSE","category":"Transporte"}
- 'recebi 300 do freela' -> {"description":"Freelance","amount":300,"type":"INCOME","category":"Trabalho & Renda"}
Remova números soltos e termos de pagamento da descrição.`
        },
        { role: 'user', content: transcription }
      ]
    });
    const content = completion.choices[0].message.content.trim().replace(/^```json\s*|\s*```$/gi, '');
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('A IA nao retornou JSON em array');
    const parsed = JSON.parse(content.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('A IA nao retornou um array de transacoes');
    return parsed;
  } catch (error) {
    if (is429(error)) throw rateLimitError();
    throw error;
  }
};