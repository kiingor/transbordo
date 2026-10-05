import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowRightLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Pause,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  X,
} from "lucide-react";
import "./style.css";

type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "operator";
  active?: number;
};
type Connection = {
  id: string;
  name: string;
  instance: string;
  managed: number;
  overflow: number;
  state: string;
  number: string | null;
  profile_name: string | null;
  profile_synced_at: number | null;
  has_photo: number;
  signal_configured: number;
  webhook_configured: number;
  last_sync: number | null;
  contacts: number;
  ignored: number;
  individual: number;
  pending: number;
  failed: number;
};
type Integration = {
  baseUrl: string;
  instance: string;
  apiKey?: string;
  signalConfigured?: boolean;
};
type Contact = {
  jid: string;
  name: string;
  phone: string | null;
  ignored: number;
  overflow: number;
};
type Delivery = {
  id: string;
  name: string;
  event: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
};
type Audit = { id: number; actor: string; name: string | null; action: string; created_at: number };
type Setup = { evolution: boolean; signal: boolean };

const errors: Record<string, string> = {
  INVALID_LOGIN: "E-mail ou senha incorretos.",
  LOGIN_REQUIRED: "Entre para continuar.",
  INVALID_PASSWORD: "A senha atual está incorreta.",
  INVALID_INPUT: "Revise os campos informados.",
  EVOLUTION_NOT_CONFIGURED: "Configure EVOLUTION_URL e EVOLUTION_API_KEY no servidor do portal.",
  SIGNAL_NOT_CONFIGURED: "Configure SIGNAL_API_ORIGIN no servidor do portal.",
  INVALID_SIGNAL_WEBHOOK:
    "Use o webhook Evolution completo gerado pelo Signal, na origem configurada.",
  CONNECTION_SETUP_REQUIRED:
    "Conecte o dispositivo e configure a integração da plataforma antes de ativar.",
  PLATFORM_INTEGRATION_REQUIRED: "Configure o Signal na conexão única da plataforma.",
  EVOLUTION_INVALID_PROFILE: "A Evolution ainda não disponibilizou o perfil do dispositivo.",
  EVOLUTION_PROFILE_NOT_FOUND: "Conecte o WhatsApp antes de sincronizar o perfil.",
  PAUSE_BEFORE_CHANGING_WEBHOOK:
    "Desative o transbordo geral e as ativações individuais antes de alterar o destino.",
  ALREADY_EXISTS: "Essa instância ou esse e-mail já está cadastrado.",
  EVOLUTION_HTTP_401: "A Evolution recusou a chave. Confira as credenciais da instância.",
  EVOLUTION_HTTP_403: "A chave não tem acesso a essa instância Evolution.",
  EVOLUTION_HTTP_404: "A instância não foi encontrada na Evolution.",
  INVALID_PHONE: "Informe o número com DDI e DDD, por exemplo 5583999990000.",
  TOO_MANY_REQUESTS: "Muitas tentativas. Aguarde um minuto e tente novamente.",
  ADMIN_REQUIRED: "Essa configuração requer um administrador.",
  CANNOT_DISABLE_SELF: "Você não pode desativar seu próprio acesso.",
  DEVICE_REMOVING: "Este dispositivo está sendo removido. Aguarde a conclusão.",
  CONNECTION_NOT_FOUND: "Este dispositivo já foi removido. Volte à lista de dispositivos.",
  EVOLUTION_REMOVE_FAILED:
    "Não foi possível concluir a remoção na Evolution. O transbordo ficou pausado; tente remover novamente.",
};
async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401 && payload.error === "LOGIN_REQUIRED")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(
      errors[payload.error] ??
        (String(payload.error).startsWith("EVOLUTION_HTTP_")
          ? "A Evolution está indisponível. Tente novamente."
          : "Não foi possível concluir a operação. Tente novamente."),
    );
  }
  return payload as T;
}
const date = (value?: number | null) =>
  value
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(
        new Date(value),
      )
    : "Ainda não sincronizado";
const stateLabel = (state: string) =>
  state === "open"
    ? "WhatsApp conectado"
    : state === "connecting"
      ? "Conectando"
      : "Aguardando conexão";
const individualLabel = (count: number) =>
  count > 0
    ? `${count} ${count === 1 ? "contato ativado" : "contatos ativados"} individualmente`
    : "Nenhum contato em transbordo";
const initials = (name: string) =>
  name
    .split(" ")
    .map((v) => v[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <ArrowRightLeft size={21} />
      </span>
      <span>
        softcom<span className="brand-product">TRANSBORDO</span>
      </span>
    </div>
  );
}
function Spinner() {
  return <LoaderCircle size={16} className="spin" />;
}
function Toggle({
  on,
  disabled,
  label,
  action,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  action: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      className={`toggle ${on ? "on" : ""}`}
      onClick={action}
    >
      <span />
    </button>
  );
}
function Empty({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
const FeedbackContext = createContext("");
function Modal({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const error = useContext(FeedbackContext);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-label={title}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Fechar" onClick={close} disabled={busy}>
          <X size={20} />
        </button>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {children}
    </dialog>
  );
}
function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  return (
    <label className="copy-field">
      <span>{label}</span>
      <div>
        <input readOnly value={value} type={secret ? "password" : "text"} aria-label={label} />
        <button
          type="button"
          aria-label={`Copiar ${label}`}
          className="icon-button"
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied(true);
                setError(false);
                setTimeout(() => setCopied(false), 1800);
              })
              .catch(() => setError(true));
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      {error && <small>Selecione o campo e copie manualmente.</small>}
    </label>
  );
}

function Login({ done }: { done: (u: User) => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/login", {
        email: form.get("email"),
        password: form.get("password"),
      });
      done(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">CADA CONVERSA, NO LUGAR CERTO</span>
          <h1>
            Seu WhatsApp.
            <br />
            Seu controle.
          </h1>
          <p>
            Escolha quando o Signal entra na conversa. Gerencie seus números e mantenha o
            atendimento no seu ritmo.
          </p>
          <div className="login-flow">
            <Smartphone />
            <span />
            <ArrowRightLeft />
            <span />
            <MessageCircle />
          </div>
        </div>
        <small>SOFTCOM · CONEXÕES QUE SIMPLIFICAM</small>
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <span className="eyebrow">PORTAL DE CONEXÕES</span>
          <h2>Bem-vindo de volta</h2>
          <p>Entre para gerenciar o transbordo da sua equipe.</p>
          <label>
            E-mail
            <input
              name="email"
              type="email"
              autoComplete="username"
              placeholder="voce@empresa.com.br"
              required
            />
          </label>
          <label>
            Senha
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? <Spinner /> : <ArrowRight size={17} />} Entrar no portal
          </button>
          <small className="login-note">
            <ShieldCheck size={14} /> Acesso exclusivo da sua equipe.
          </small>
        </form>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined),
    [setup, setSetup] = useState<Setup>({ evolution: true, signal: true });
  const [tab, setTab] = useState("connections"),
    [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<string | null>(null),
    [create, setCreate] = useState(false),
    [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null),
    [integration, setIntegration] = useState<Integration | null>(null);
  const [search, setSearch] = useState(""),
    [passwordOpen, setPasswordOpen] = useState(false);
  const refresh = useCallback(async () => {
    const [result, platform] = await Promise.all([
      api<{ connections: Connection[] }>("/connections"),
      api<Integration>("/platform"),
    ]);
    setConnections(result.connections);
    setIntegration(platform);
  }, []);
  useEffect(() => {
    const expired = () => {
      setUser(null);
      setIntegration(null);
      setSelected(null);
      setTab("connections");
    };
    window.addEventListener("session-expired", expired);
    api<{ user: User; setup: Setup }>("/me")
      .then((r) => {
        setUser(r.user);
        setSetup(r.setup);
      })
      .catch(() => setUser(null));
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh().catch((e) => setNotice({ error: true, text: e.message }));
    api<{ setup: Setup }>("/me")
      .then((r) => setSetup(r.setup))
      .catch(() => {});
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, [user, refresh]);
  async function run(key: string, fn: () => Promise<void>, message?: string) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      await refresh();
      if (message) setNotice({ error: false, text: message });
    } catch (e) {
      await refresh().catch(() => {});
      setNotice({ error: true, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  if (user === undefined)
    return (
      <div className="loading">
        <Spinner /> Abrindo portal…
      </div>
    );
  if (!user) return <Login done={setUser} />;
  const current = connections.find((c) => c.id === selected);
  const active = connections.filter((c) => c.overflow || c.individual > 0).length;
  const title = tab === "activity" ? "Atividade" : tab === "team" ? "Equipe" : "Dispositivos";
  return (
    <FeedbackContext.Provider value={notice?.error ? notice.text : ""}>
      <div className="shell">
        <aside className="sidebar">
          <Brand />
          <div className="workspace">
            <span className="workspace-avatar">S</span>
            <div>
              <strong>Minha equipe</strong>
              <small>Portal de atendimento</small>
            </div>
          </div>
          <span className="nav-caption">GERENCIAR</span>
          <nav>
            <button
              className={tab === "connections" ? "active" : ""}
              onClick={() => setTab("connections")}
            >
              <Smartphone size={19} /> Dispositivos <span>{connections.length}</span>
            </button>
            <button
              className={tab === "activity" ? "active" : ""}
              onClick={() => setTab("activity")}
            >
              <Activity size={19} /> Atividade
            </button>
            {user.role === "admin" && (
              <button className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>
                <Users size={19} /> Equipe
              </button>
            )}
          </nav>
          <div className="sidebar-tip">
            <CircleHelp size={19} />
            <strong>Você decide quando.</strong>
            <p>
              Ative contatos individualmente ou ligue o geral. Contatos ignorados ficam no WhatsApp.
            </p>
          </div>
          <div className="profile">
            <button
              className="profile-name"
              onClick={() => setPasswordOpen(true)}
              title="Alterar minha senha"
            >
              <span className="avatar">{initials(user.name)}</span>
              <span>
                <strong>{user.name}</strong>
                <small>{user.role === "admin" ? "Administrador" : "Operador"}</small>
              </span>
            </button>
            <button
              className="icon-button"
              aria-label="Sair"
              onClick={() =>
                void run("logout", async () => {
                  await api("/logout", {});
                  setUser(null);
                  setIntegration(null);
                  setSelected(null);
                  setTab("connections");
                })
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </aside>
        <main>
          <div className="topbar">
            <span>
              Workspace <ChevronRight size={13} /> <b>{title}</b>
            </span>
            <span className="secure">
              <ShieldCheck size={14} /> Acesso da equipe
            </span>
          </div>
          <div className="content">
            <header className="page-heading">
              <div>
                <span className="eyebrow">WHATSAPP + SIGNAL</span>
                <h1>
                  {current && tab === "connections" ? current.profile_name || current.name : title}
                </h1>
                <p>
                  {tab === "connections"
                    ? "Uma conexão com o Signal, todos os seus dispositivos."
                    : tab === "activity"
                      ? "Acompanhe encaminhamentos e alterações da sua equipe."
                      : "Pessoas com acesso aos números e ao transbordo."}
                </p>
              </div>
              {tab === "connections" && user.role === "admin" && (
                <button className="primary" onClick={() => setCreate(true)}>
                  <Plus size={17} /> Adicionar dispositivo
                </button>
              )}
            </header>
            {notice && (
              <div
                className={notice.error ? "notice error" : "notice success"}
                role={notice.error ? "alert" : "status"}
              >
                {notice.error ? <CircleHelp size={18} /> : <Check size={18} />}
                <span>{notice.text}</span>
                <button
                  className="icon-button"
                  aria-label="Fechar aviso"
                  onClick={() => setNotice(null)}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {(!setup.evolution || !setup.signal) && (
              <div className="setup-note">
                <Settings2 size={19} />
                <div>
                  <strong>Prepare as integrações</strong>
                  <p>
                    {!setup.evolution ? "A Evolution ainda não foi configurada. " : ""}
                    {!setup.signal ? "Falta informar a origem da API do Signal. " : ""}O
                    administrador deve preencher essas informações no arquivo .env do portal.
                  </p>
                </div>
              </div>
            )}
            {tab === "connections" && !current && (
              <>
                <PlatformIntegration
                  integration={integration}
                  user={user}
                  busy={busy}
                  run={run}
                  active={active}
                />
                <div className="stats">
                  <div>
                    <span className="stat-icon">
                      <Smartphone size={21} />
                    </span>
                    <span>
                      <small>Dispositivos conectados</small>
                      <strong>
                        {connections.filter((c) => c.state === "open").length}
                        <em> / {connections.length}</em>
                      </strong>
                    </span>
                  </div>
                  <div>
                    <span className="stat-icon green">
                      <ArrowRightLeft size={21} />
                    </span>
                    <span>
                      <small>Transbordo ativo</small>
                      <strong>
                        {active}
                        <em> {active === 1 ? "número" : "números"}</em>
                      </strong>
                    </span>
                  </div>
                  <div>
                    <span className="stat-icon amber">
                      <Pause size={21} />
                    </span>
                    <span>
                      <small>Transbordo pausado</small>
                      <strong>
                        {connections.length - active}
                        <em> {connections.length - active === 1 ? "número" : "números"}</em>
                      </strong>
                    </span>
                  </div>
                </div>
                <div className="section-heading">
                  <div>
                    <h2>
                      Seus dispositivos <span className="count">{connections.length}</span>
                    </h2>
                    <p>Ative, pause e escolha quais contatos encaminhar.</p>
                  </div>
                  <div className="search">
                    <Search size={17} />
                    <input
                      placeholder="Buscar número ou nome"
                      aria-label="Buscar dispositivo"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>
                {connections.length === 0 ? (
                  <Empty
                    icon={<Smartphone size={30} />}
                    title="Seu primeiro dispositivo começa aqui"
                    text="Conecte um WhatsApp à plataforma e ative o transbordo quando estiver pronto."
                  >
                    {user.role === "admin" && (
                      <button className="primary" onClick={() => setCreate(true)}>
                        <Plus size={17} /> Adicionar dispositivo
                      </button>
                    )}
                  </Empty>
                ) : (
                  <div className="connection-grid">
                    {connections
                      .filter((c) =>
                        `${c.profile_name ?? ""} ${c.name} ${c.number ?? ""} ${c.instance}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map((c) => (
                        <article className="connection-card" key={c.id}>
                          <div className="card-title">
                            <DeviceAvatar device={c} />
                            <div>
                              <h3>{c.profile_name || c.name}</h3>
                              <span>
                                {c.number
                                  ? `+${c.number}`
                                  : c.state === "open"
                                    ? "Número vinculado à instância"
                                    : "Número aguardando pareamento"}
                              </span>
                            </div>
                            <span
                              className={`dot ${c.state === "open" ? "green" : ""}`}
                              title={stateLabel(c.state)}
                            />
                          </div>
                          <span className={`connection-state ${c.state === "open" ? "green" : ""}`}>
                            <Radio size={13} /> {stateLabel(c.state)}
                          </span>
                          <div className={`overflow-control ${c.overflow ? "enabled" : ""}`}>
                            <div>
                              <strong>
                                Transbordo geral {c.overflow ? "ligado" : "desligado"}
                              </strong>
                              <small>
                                {c.overflow
                                  ? "Todos, exceto os ignorados"
                                  : individualLabel(c.individual)}
                              </small>
                            </div>
                            <Toggle
                              on={!!c.overflow}
                              disabled={!!busy}
                              label={`Transbordo de ${c.name}`}
                              action={() =>
                                void run(c.id, async () => {
                                  await api(
                                    `/connections/${c.id}`,
                                    { overflow: !c.overflow },
                                    "PATCH",
                                  );
                                })
                              }
                            />
                          </div>
                          <div className="card-meta">
                            <span>
                              <Users size={14} /> {c.contacts} contatos
                            </span>
                            <span>{c.ignored} ignorados</span>
                            {c.pending > 0 && <span>{c.pending} pendentes</span>}
                          </div>
                          {c.failed > 0 && (
                            <small className="failed-note">
                              {c.failed} encaminhamentos com falha — consulte Atividade
                            </small>
                          )}
                          <button
                            className="card-link"
                            onClick={() => {
                              setSelected(c.id);
                            }}
                          >
                            <span>Gerenciar dispositivo</span>
                            <ArrowRight size={16} />
                          </button>
                        </article>
                      ))}
                  </div>
                )}
                <div className="flow-note">
                  <span>
                    <Smartphone size={17} /> WhatsApp
                  </span>
                  <ArrowRight size={15} />
                  <span>
                    <ArrowRightLeft size={17} /> Transbordo
                  </span>
                  <ArrowRight size={15} />
                  <span>
                    <MessageCircle size={17} /> Signal
                  </span>
                  <p>As respostas retornam pelo mesmo número.</p>
                </div>
              </>
            )}
            {tab === "connections" && current && (
              <ConnectionDetail
                connection={current}
                user={user}
                busy={busy}
                run={run}
                back={() => {
                  setSelected(null);
                }}
              />
            )}
            {tab === "activity" && <ActivityPage />}
            {tab === "team" && user.role === "admin" && <Team busy={busy} run={run} user={user} />}
          </div>
          <footer>
            Softcom Transbordo <span>O atendimento continua no seu ritmo.</span>
          </footer>
        </main>
        {create && (
          <Modal title="Adicionar dispositivo" close={() => setCreate(false)}>
            <NewConnection
              busy={!!busy}
              submit={(body) =>
                void run("create", async () => {
                  const result = await api<{ id: string }>("/connections", body);
                  setSelected(result.id);
                  setCreate(false);
                  setTab("connections");
                })
              }
            />
          </Modal>
        )}
        {passwordOpen && (
          <Modal title="Alterar minha senha" close={() => setPasswordOpen(false)}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run("password", async () => {
                  await api("/password", {
                    current: f.get("current"),
                    password: f.get("password"),
                  });
                  setPasswordOpen(false);
                  setUser(null);
                });
              }}
            >
              <label>
                Senha atual
                <input type="password" name="current" required autoComplete="current-password" />
              </label>
              <label>
                Nova senha
                <input
                  type="password"
                  name="password"
                  minLength={12}
                  required
                  autoComplete="new-password"
                />
              </label>
              <small>Use pelo menos 12 caracteres. Você entrará novamente após salvar.</small>
              <button disabled={!!busy} className="primary full">
                Salvar senha
              </button>
            </form>
          </Modal>
        )}
      </div>
    </FeedbackContext.Provider>
  );
}

function NewConnection({ submit, busy }: { submit: (body: unknown) => void; busy: boolean }) {
  const [existing, setExisting] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        submit({
          name: f.get("name"),
          ...(existing ? { instance: f.get("instance"), evolutionKey: f.get("evolutionKey") } : {}),
        });
      }}
    >
      <p className="muted">Cada número tem seu próprio transbordo e lista de contatos ignorados.</p>
      <label>
        Nome do dispositivo
        <input
          name="name"
          placeholder="Ex.: Atendimento comercial"
          minLength={2}
          maxLength={120}
          required
          autoFocus
        />
      </label>
      <div className="segmented">
        <button
          type="button"
          className={!existing ? "active" : ""}
          onClick={() => setExisting(false)}
        >
          Conectar por QR Code
        </button>
        <button
          type="button"
          className={existing ? "active" : ""}
          onClick={() => setExisting(true)}
        >
          Instância existente
        </button>
      </div>
      {existing ? (
        <>
          <label>
            Nome da instância Evolution
            <input name="instance" required pattern="[A-Za-z0-9_-]+" maxLength={120} />
          </label>
          <label>
            Chave dessa instância
            <input
              name="evolutionKey"
              type="password"
              required
              minLength={16}
              autoComplete="new-password"
            />
          </label>
          <div className="info">
            Ao conectar, os webhooks dessa instância passam a ser recebidos pelo portal.
          </div>
        </>
      ) : (
        <div className="info">
          <Smartphone size={19} />
          <span>Você escaneará o QR Code na próxima etapa. O transbordo começa pausado.</span>
        </div>
      )}
      <button className="primary full" disabled={busy}>
        {busy ? <Spinner /> : <ArrowRight size={16} />} Criar dispositivo
      </button>
    </form>
  );
}
type Run = (key: string, fn: () => Promise<void>, message?: string) => Promise<void>;
function DeviceAvatar({ device }: { device: Connection }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [device.id, device.profile_synced_at]);
  return (
    <span className="number-icon device-avatar">
      {device.has_photo && !failed ? (
        <img
          src={`/api/connections/${device.id}/photo?v=${device.profile_synced_at ?? 0}`}
          alt={`Foto de ${device.profile_name || device.name}`}
          onError={() => setFailed(true)}
        />
      ) : (
        <Smartphone size={23} />
      )}
    </span>
  );
}
function PlatformIntegration({
  integration,
  user,
  busy,
  run,
  active,
}: {
  integration: Integration | null;
  user: User;
  busy: string;
  run: Run;
  active: number;
}) {
  const [signal, setSignal] = useState("");
  return (
    <section className="panel platform-panel">
      <div className="section-heading">
        <div>
          <h2>
            <Link2 size={20} /> Conexão da plataforma
          </h2>
          <p>Um único canal no Signal recebe todos os dispositivos desta equipe.</p>
        </div>
        <span className={`connection-state ${integration?.signalConfigured ? "green" : ""}`}>
          {integration?.signalConfigured ? "Signal configurado" : "Aguardando configuração"}
        </span>
      </div>
      {user.role === "admin" && integration && (
        <details>
          <summary>Configurar conexão com o Signal</summary>
          <p>
            No Signal, crie um único canal Evolution com <strong>Conexão externa</strong>. Use os
            dados da plataforma abaixo e salve aqui o webhook gerado. Novos dispositivos passam a
            usar a mesma integração.
          </p>
          <div className="platform-fields">
            <CopyField label="URL da plataforma" value={integration.baseUrl} />
            <CopyField label="Identificador da plataforma" value={integration.instance} />
            {integration.apiKey && (
              <CopyField label="Chave da plataforma" value={integration.apiKey} secret />
            )}
          </div>
          <form
            className="webhook-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                "platform",
                async () => {
                  await api("/platform", { signalUrl: signal }, "PATCH");
                  setSignal("");
                },
                "Conexão da plataforma com o Signal configurada.",
              );
            }}
          >
            <label>
              Webhook único do Signal
              <input
                type="password"
                autoComplete="new-password"
                required
                value={signal}
                onChange={(e) => setSignal(e.target.value)}
                placeholder={
                  integration.signalConfigured
                    ? "Configurado · cole aqui para substituir"
                    : "Cole a URL completa do webhook"
                }
              />
            </label>
            <button className="primary" disabled={!!busy || active > 0}>
              {busy === "platform" ? <Spinner /> : <Link2 size={15} />} Salvar conexão da plataforma
            </button>
            {active > 0 && (
              <small>
                Desative o transbordo geral e as ativações individuais antes de alterar a conexão.
              </small>
            )}
          </form>
        </details>
      )}
    </section>
  );
}
function ConnectionDetail({
  connection: c,
  user,
  busy,
  run,
  back,
}: {
  connection: Connection;
  user: User;
  busy: string;
  run: Run;
  back: () => void;
}) {
  const [tab, setTab] = useState("contacts"),
    [qr, setQr] = useState<string | null>(null),
    [removeOpen, setRemoveOpen] = useState(false);
  useEffect(() => {
    setQr(null);
    setRemoveOpen(false);
    setTab(c.webhook_configured || user.role !== "admin" ? "contacts" : "setup");
  }, [c.id]);
  useEffect(() => {
    if (!qr) return;
    const timer = setInterval(() => {
      api<{ state: string; qrCode: string | null }>(`/connections/${c.id}/qr`)
        .then((r) => setQr(r.state === "open" ? null : r.qrCode))
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [qr, c.id]);
  return (
    <>
      <button className="back" onClick={back}>
        <ChevronLeft size={15} /> Todos os dispositivos
      </button>
      <div className="detail-banner">
        <DeviceAvatar device={c} />
        <div>
          <strong>{c.profile_name || c.name}</strong>
          {" · "}
          <span>{c.number ? `+${c.number}` : "Aguardando pareamento"}</span>
          <small>{stateLabel(c.state)}</small>
        </div>
        <div className="detail-toggle">
          <span>
            Transbordo geral <b>{c.overflow ? "ligado" : "desligado"}</b>
            <small>
              {c.overflow ? "Todos, exceto os ignorados" : individualLabel(c.individual)}
            </small>
          </span>
          <Toggle
            on={!!c.overflow}
            disabled={!!busy}
            label="Ativar transbordo geral"
            action={() =>
              void run("overflow", async () => {
                await api(`/connections/${c.id}`, { overflow: !c.overflow }, "PATCH");
              })
            }
          />
        </div>
      </div>
      <div className="tabs">
        <button className={tab === "contacts" ? "active" : ""} onClick={() => setTab("contacts")}>
          <Users size={16} /> Contatos e exceções
        </button>
        {user.role === "admin" && (
          <button className={tab === "setup" ? "active" : ""} onClick={() => setTab("setup")}>
            <Smartphone size={16} /> Dispositivo e perfil
          </button>
        )}
      </div>
      {tab === "contacts" && <Contacts connection={c} busy={busy} run={run} />}
      {tab === "setup" && user.role === "admin" && (
        <div className="setup-grid">
          <section className="panel">
            <h2>
              <span className="step">1</span> Conecte o WhatsApp
            </h2>
            <p>Abra o WhatsApp no celular, acesse Aparelhos conectados e escaneie o QR Code.</p>
            {qr ? (
              <img className="qr" src={qr} alt="QR Code para conectar o WhatsApp" />
            ) : (
              <div className="pair-placeholder">
                <Smartphone size={36} />
                <strong>
                  {c.state === "open" ? "WhatsApp conectado" : "Pronto para conectar"}
                </strong>
              </div>
            )}
            <div className="button-row">
              <button
                className="primary"
                disabled={!!busy}
                onClick={() =>
                  void run("connect", async () => {
                    const r = await api<{ qrCode: string | null }>(
                      `/connections/${c.id}/connect`,
                      {},
                    );
                    setQr(r.qrCode);
                  })
                }
              >
                {busy === "connect" ? <Spinner /> : <Smartphone size={16} />}
                {c.webhook_configured ? "Atualizar QR Code" : "Conectar WhatsApp"}
              </button>
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  void run(
                    "status",
                    async () => {
                      const r = await api<{ state: string }>(`/connections/${c.id}/status`);
                      if (r.state === "open") setQr(null);
                    },
                    "Estado da conexão atualizado.",
                  )
                }
              >
                <RefreshCw size={15} /> Verificar
              </button>
            </div>
            {c.webhook_configured > 0 && (
              <div className="inline-success">
                <Check size={14} /> Recebimento de webhooks configurado
              </div>
            )}
          </section>
          <section className="panel">
            <h2>Perfil do dispositivo</h2>
            <p>Nome de usuário, foto e número são sincronizados do WhatsApp pela Evolution.</p>
            <div className="device-profile">
              <DeviceAvatar device={c} />
              <div>
                <strong>{c.profile_name || c.name}</strong>
                <p>{c.number ? `+${c.number}` : "Número ainda não conectado"}</p>
              </div>
            </div>
            <p className="muted">Última sincronização: {date(c.profile_synced_at)}</p>
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() =>
                void run(
                  "profile",
                  async () => {
                    await api(`/connections/${c.id}/profile`, {});
                  },
                  "Nome e foto do dispositivo sincronizados.",
                )
              }
            >
              <RefreshCw size={16} /> Sincronizar perfil
            </button>
            <div className="flow-note">
              <Link2 size={16} />
              <p>Este dispositivo usa a conexão única da plataforma com o Signal.</p>
            </div>
          </section>
          <section className="panel remove-device">
            <h2>
              <Trash2 size={18} /> Remover dispositivo
            </h2>
            <p>
              Retire este dispositivo e seus contatos do portal. A conexão da plataforma e os demais
              dispositivos continuam funcionando.
            </p>
            <button className="danger" disabled={!!busy} onClick={() => setRemoveOpen(true)}>
              <Trash2 size={16} /> Remover dispositivo
            </button>
          </section>
        </div>
      )}
      {removeOpen && user.role === "admin" && (
        <Modal title="Remover este dispositivo?" close={() => setRemoveOpen(false)} busy={!!busy}>
          <div className="device-profile">
            <DeviceAvatar device={c} />
            <div>
              <strong>{c.profile_name || c.name}</strong>
              <p>{c.number ? `+${c.number}` : c.name}</p>
            </div>
          </div>
          <p>
            Os contatos, as exceções e o histórico deste dispositivo no portal serão excluídos. As
            conversas já recebidas no Signal serão mantidas.
          </p>
          <p>
            {c.managed
              ? "A conexão com o WhatsApp será encerrada. Para usar este número novamente, será necessário fazer um novo pareamento."
              : "A instância existente na Evolution será mantida. Apenas o webhook deste portal será desativado."}
          </p>
          <p>
            O transbordo geral e as ativações individuais serão desligados ao confirmar. Envios já
            em andamento podem terminar antes da remoção.
          </p>
          <div className="button-row">
            <button className="secondary" disabled={!!busy} onClick={() => setRemoveOpen(false)}>
              Cancelar
            </button>
            <button
              className="danger"
              disabled={!!busy}
              onClick={() =>
                void run(
                  "remove-device",
                  async () => {
                    await api(`/connections/${c.id}`, {}, "DELETE");
                    setRemoveOpen(false);
                    back();
                  },
                  "Dispositivo removido. A conexão da plataforma com o Signal foi mantida.",
                )
              }
            >
              {busy === "remove-device" ? <Spinner /> : <Trash2 size={16} />}
              {busy === "remove-device" ? "Removendo…" : "Confirmar remoção"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Contacts({
  connection: c,
  busy,
  run,
}: {
  connection: Connection;
  busy: string;
  run: Run;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [add, setAdd] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const r = await api<{ contacts: Contact[]; total: number }>(
      `/connections/${c.id}/contacts?search=${encodeURIComponent(search)}&ignored=${filter === "individual" ? "all" : filter}&overflow=${filter === "individual" ? "true" : "all"}&page=${page}`,
    );
    setContacts(r.contacts);
    setTotal(r.total);
    setError("");
  }, [c.id, search, filter, page]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      refresh()
        .catch((e) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  return (
    <section className="panel contacts-panel">
      <div className="section-heading">
        <div>
          <h2>Quem pode chegar ao Signal?</h2>
          <p>Ative só quem você escolher, mesmo com o transbordo geral desligado.</p>
        </div>
        <div className="button-row">
          <button className="secondary" onClick={() => setAdd(true)}>
            <Plus size={15} /> Ignorar número
          </button>
          <button
            className="secondary"
            disabled={!!busy}
            onClick={() =>
              void run(
                "sync",
                async () => {
                  await api(`/connections/${c.id}/sync`, {});
                  await refresh();
                },
                "Contatos sincronizados sem alterar as exceções.",
              )
            }
          >
            <RefreshCw size={15} className={busy === "sync" ? "spin" : ""} /> Sincronizar
          </button>
        </div>
      </div>
      <p className="contact-rule">
        <strong>Ativação individual</strong> mantém o contato em transbordo sem ligar o geral. Com o
        geral ligado, todos entram; use <strong>Ignorar</strong> para impedir um contato em qualquer
        modo. Só novas mensagens são encaminhadas.
      </p>
      <div className="contact-tools">
        <div className="search">
          <Search size={16} />
          <input
            aria-label="Buscar contato"
            placeholder="Buscar nome ou número"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          aria-label="Filtrar contatos"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">Todos os contatos</option>
          <option value="true">Ignorados</option>
          <option value="false">Não ignorados</option>
          <option value="individual">Ativação individual ligada</option>
        </select>
        <small>Última sincronização: {date(c.last_sync)}</small>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {loading ? (
        <div className="loading">
          <Spinner /> Carregando contatos…
        </div>
      ) : contacts.length === 0 ? (
        <Empty
          icon={<Users size={26} />}
          title="Nenhum contato encontrado"
          text={
            search || filter !== "all"
              ? "Tente outro nome, número ou filtro."
              : "Sincronize os contatos da Evolution ou adicione um número para ignorar."
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Contato</th>
                <th>Número</th>
                <th>Encaminhamento</th>
                <th>Ativação individual</th>
                <th>Ignorar</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.jid}>
                  <td>
                    <div className="contact-name">
                      <span className="avatar">{initials(contact.name || "?")}</span>
                      <strong>{contact.name || "Sem nome"}</strong>
                    </div>
                  </td>
                  <td>{contact.phone ? `+${contact.phone}` : contact.jid}</td>
                  <td data-label="Encaminhamento">
                    <span
                      className={`badge ${!contact.ignored && (c.overflow || contact.overflow) ? "green" : "neutral"}`}
                    >
                      {contact.ignored
                        ? "Ignorado"
                        : contact.overflow
                          ? "Ativo · individual"
                          : c.overflow
                            ? "Ativo · geral"
                            : "Desativado"}
                    </span>
                  </td>
                  <td data-label="Ativação individual">
                    <Toggle
                      on={!!contact.overflow}
                      disabled={!!busy}
                      label={`Ativar transbordo de ${contact.name || contact.phone || contact.jid}`}
                      action={() =>
                        void run("contact", async () => {
                          await api(
                            `/connections/${c.id}/contacts`,
                            { jid: contact.jid, overflow: !contact.overflow },
                            "PATCH",
                          );
                          await refresh();
                        })
                      }
                    />
                  </td>
                  <td data-label="Ignorar">
                    <Toggle
                      on={!!contact.ignored}
                      disabled={!!busy}
                      label={`Ignorar ${contact.name || contact.phone || contact.jid}`}
                      action={() =>
                        void run("contact", async () => {
                          await api(
                            `/connections/${c.id}/contacts`,
                            { jid: contact.jid, ignored: !contact.ignored },
                            "PATCH",
                          );
                          await refresh();
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <small>{total} contatos</small>
        <div>
          <button
            className="icon-button"
            aria-label="Página anterior"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <span>
            {page} / {Math.max(1, Math.ceil(total / 50))}
          </span>
          <button
            className="icon-button"
            aria-label="Próxima página"
            disabled={page * 50 >= total}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      {add && (
        <Modal title="Ignorar um número" close={() => setAdd(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(
                "add-contact",
                async () => {
                  await api(`/connections/${c.id}/contacts`, {
                    phone: f.get("phone"),
                    name: f.get("name"),
                    ignored: true,
                  });
                  await refresh();
                  setAdd(false);
                },
                "Número adicionado à lista de ignorados.",
              );
            }}
          >
            <label>
              Nome
              <input name="name" placeholder="Opcional" maxLength={120} />
            </label>
            <label>
              Número com DDI e DDD
              <input name="phone" type="tel" placeholder="5583999990000" required />
            </label>
            <button className="primary full" disabled={!!busy}>
              Ignorar contato
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}

const statusNames: Record<string, string> = {
  delivered: "Entregue",
  ignored: "Ignorado",
  pending: "Pendente",
  processing: "Enviando",
  failed: "Falhou",
};
const reasonNames: Record<string, string> = {
  OVERFLOW_DISABLED: "Transbordo pausado",
  CONTACT_IGNORED: "Contato ignorado",
  UNSUPPORTED_CHAT: "Grupo ou status",
  DELIVERY_EXPIRED: "Prazo de entrega esgotado",
  SIGNAL_UNREACHABLE: "Signal indisponível",
  BEFORE_ACTIVATION: "Anterior à ativação",
  IDENTITY_UNRESOLVED: "Identidade pendente · sincronize contatos",
  DEVICE_REMOVED: "Remoção do dispositivo",
};
const auditNames: Record<string, string> = {
  "overflow.enabled": "Ativou o transbordo geral",
  "overflow.disabled": "Desativou o transbordo geral",
  "contact.overflow_enabled": "Ativou o transbordo individual de um contato",
  "contact.overflow_disabled": "Desativou o transbordo individual de um contato",
  "contact.ignored": "Ignorou um contato",
  "contact.allowed": "Liberou um contato",
  "contacts.synced": "Sincronizou contatos",
  "connection.created": "Adicionou uma conexão",
  "connection.removed": "Removeu um dispositivo",
  "connection.removal_failed": "Não foi possível remover o dispositivo",
  "connection.signal_configured": "Configurou o Signal",
  "connection.webhook_installed": "Conectou o recebimento",
  "connection.key_rotated": "Gerou nova chave",
  "session.created": "Entrou no portal",
  "response.sent": "Enviou resposta ao WhatsApp",
  "response.failed": "Falha na resposta",
  "user.created": "Adicionou um usuário",
  "user.disabled": "Desativou um usuário",
  "user.enabled": "Ativou um usuário",
  "password.changed": "Alterou a senha",
};
function ActivityPage() {
  const [data, setData] = useState<{ deliveries: Delivery[]; audit: Audit[] }>({
      deliveries: [],
      audit: [],
    }),
    [error, setError] = useState("");
  useEffect(() => {
    const refresh = () =>
      api<typeof data>("/activity")
        .then((r) => {
          setData(r);
          setError("");
        })
        .catch((e) => setError(e.message));
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <section className="panel">
        <h2>Encaminhamentos recentes</h2>
        <p className="muted">
          Últimos 100 eventos. Mensagens pausadas ou ignoradas não são reenviadas.
        </p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {!data.deliveries.length ? (
          <Empty
            icon={<ArrowDownLeft size={27} />}
            title="Tudo pronto para acompanhar"
            text="Os encaminhamentos aparecerão aqui quando a Evolution enviar os primeiros eventos."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dispositivo</th>
                  <th>Evento</th>
                  <th>Resultado</th>
                  <th>Detalhes</th>
                  <th>Recebido</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.name}</strong>
                    </td>
                    <td>{d.event === "MESSAGES_UPSERT" ? "Mensagem" : "Status da mensagem"}</td>
                    <td>
                      <span
                        className={`badge ${d.status === "delivered" ? "green" : d.status === "failed" ? "red" : "neutral"}`}
                      >
                        {statusNames[d.status]}
                      </span>
                    </td>
                    <td>
                      {d.last_error
                        ? (reasonNames[d.last_error] ??
                          (d.last_error.startsWith("SIGNAL_HTTP_")
                            ? `Signal respondeu ${d.last_error.slice(12)}`
                            : "Entrega não concluída"))
                        : `${d.attempts} tentativa(s)`}
                    </td>
                    <td>{date(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel audit-panel">
        <h2>Alterações da equipe</h2>
        {!data.audit.length ? (
          <p className="muted">Nenhuma alteração registrada.</p>
        ) : (
          data.audit.map((a) => (
            <div className="audit-row" key={a.id}>
              <span className="audit-dot" />
              <div>
                <strong>{auditNames[a.action] ?? a.action}</strong>
                <small>
                  {a.actor}
                  {a.name ? ` · ${a.name}` : ""}
                </small>
              </div>
              <time>{date(a.created_at)}</time>
            </div>
          ))
        )}
      </section>
    </>
  );
}
function Team({ busy, run, user }: { busy: string; run: Run; user: User }) {
  const [users, setUsers] = useState<User[]>([]),
    [add, setAdd] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const r = await api<{ users: User[] }>("/users");
    setUsers(r.users);
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Acessos da equipe</h2>
          <p>
            Operadores controlam transbordo e contatos. Administradores também configuram conexões e
            acessos.
          </p>
        </div>
        <button className="primary" onClick={() => setAdd(true)}>
          <Plus size={16} /> Adicionar pessoa
        </button>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pessoa</th>
              <th>E-mail</th>
              <th>Perfil</th>
              <th>Acesso ativo</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                  {u.id === user.id && <small> · você</small>}
                </td>
                <td>{u.email}</td>
                <td>{u.role === "admin" ? "Administrador" : "Operador"}</td>
                <td>
                  <Toggle
                    on={!!u.active}
                    disabled={!!busy || u.id === user.id}
                    label={`Acesso de ${u.name}`}
                    action={() =>
                      void run("user", async () => {
                        await api(`/users/${u.id}`, { active: !u.active }, "PATCH");
                        await refresh();
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {add && (
        <Modal title="Adicionar pessoa" close={() => setAdd(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(
                "add-user",
                async () => {
                  await api("/users", Object.fromEntries(f));
                  await refresh();
                  setAdd(false);
                },
                "Acesso criado. Compartilhe a senha diretamente com a pessoa.",
              );
            }}
          >
            <label>
              Nome
              <input name="name" required minLength={2} />
            </label>
            <label>
              E-mail
              <input name="email" type="email" required autoComplete="off" />
            </label>
            <label>
              Senha inicial
              <input
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
              />
            </label>
            <label>
              Perfil
              <select name="role">
                <option value="operator">Operador</option>
                <option value="admin">Administrador</option>
              </select>
            </label>
            <button className="primary full" disabled={!!busy}>
              Criar acesso
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
