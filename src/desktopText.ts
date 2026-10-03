// Strings for the Karlsen Desktop local-node integration, in all 12 wallet languages.
// Kept in their own module so the shared locale files stay untouched; only shown inside Desktop.
import type { Lang } from './config';

export type DesktopKey =
  | 'nodeLocal'
  | 'nodePublicLocalSyncing'
  | 'nodePublicLocalStarting'
  | 'nodeLocalOnlySyncing'
  | 'nodeLocalOnlyStarting'
  | 'localOnlyLabel'
  | 'localOnlyHelp'
  | 'desktopNodeUnreachable';

type Table = Record<DesktopKey, string>;

// {p} = sync progress in percent.
const en: Table = {
  nodeLocal: 'Local node (Karlsen Desktop) ✓',
  nodePublicLocalSyncing: 'Public node in use · local node syncing {p}%',
  nodePublicLocalStarting: 'Public node in use · local node starting',
  nodeLocalOnlySyncing: 'Local node syncing · balance may be incomplete until it finishes',
  nodeLocalOnlyStarting: 'Local node starting…',
  localOnlyLabel: 'Use only the local node',
  localOnlyHelp: 'Never connects to the public node. Until the local node has finished syncing, balance and history may be incomplete.',
  desktopNodeUnreachable: 'The local node is not answering yet. Karlsen Desktop restarts it automatically; try again in a few seconds.',
};

const TABLES: Record<Lang, Table> = {
  en,
  de: {
    nodeLocal: 'Lokaler Node (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Öffentlicher Node aktiv · lokaler Node synchronisiert {p}%',
    nodePublicLocalStarting: 'Öffentlicher Node aktiv · lokaler Node startet',
    nodeLocalOnlySyncing: 'Lokaler Node synchronisiert · Guthaben bis zum Abschluss evtl. unvollständig',
    nodeLocalOnlyStarting: 'Lokaler Node startet…',
    localOnlyLabel: 'Nur den lokalen Node verwenden',
    localOnlyHelp: 'Verbindet sich nie mit dem öffentlichen Node. Bis der lokale Node synchronisiert ist, können Guthaben und Verlauf unvollständig sein.',
    desktopNodeUnreachable: 'Der lokale Node antwortet noch nicht. Karlsen Desktop startet ihn automatisch neu; bitte in ein paar Sekunden erneut versuchen.',
  },
  es: {
    nodeLocal: 'Nodo local (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Usando nodo público · nodo local sincronizando {p}%',
    nodePublicLocalStarting: 'Usando nodo público · nodo local iniciando',
    nodeLocalOnlySyncing: 'Nodo local sincronizando · el saldo puede estar incompleto hasta que termine',
    nodeLocalOnlyStarting: 'Nodo local iniciando…',
    localOnlyLabel: 'Usar solo el nodo local',
    localOnlyHelp: 'Nunca se conecta al nodo público. Hasta que el nodo local termine de sincronizar, el saldo y el historial pueden estar incompletos.',
    desktopNodeUnreachable: 'El nodo local aún no responde. Karlsen Desktop lo reinicia automáticamente; inténtalo de nuevo en unos segundos.',
  },
  fr: {
    nodeLocal: 'Nœud local (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Nœud public utilisé · nœud local en synchronisation {p} %',
    nodePublicLocalStarting: 'Nœud public utilisé · démarrage du nœud local',
    nodeLocalOnlySyncing: 'Nœud local en synchronisation · le solde peut être incomplet jusqu’à la fin',
    nodeLocalOnlyStarting: 'Démarrage du nœud local…',
    localOnlyLabel: 'Utiliser uniquement le nœud local',
    localOnlyHelp: 'Ne se connecte jamais au nœud public. Tant que le nœud local n’est pas synchronisé, le solde et l’historique peuvent être incomplets.',
    desktopNodeUnreachable: 'Le nœud local ne répond pas encore. Karlsen Desktop le redémarre automatiquement ; réessayez dans quelques secondes.',
  },
  id: {
    nodeLocal: 'Node lokal (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Memakai node publik · node lokal sinkronisasi {p}%',
    nodePublicLocalStarting: 'Memakai node publik · node lokal sedang dimulai',
    nodeLocalOnlySyncing: 'Node lokal sinkronisasi · saldo mungkin belum lengkap sampai selesai',
    nodeLocalOnlyStarting: 'Node lokal sedang dimulai…',
    localOnlyLabel: 'Hanya gunakan node lokal',
    localOnlyHelp: 'Tidak pernah terhubung ke node publik. Sampai node lokal selesai sinkronisasi, saldo dan riwayat mungkin belum lengkap.',
    desktopNodeUnreachable: 'Node lokal belum merespons. Karlsen Desktop akan memulai ulang secara otomatis; coba lagi dalam beberapa detik.',
  },
  ja: {
    nodeLocal: 'ローカルノード（Karlsen Desktop）✓',
    nodePublicLocalSyncing: '公開ノードを使用中 · ローカルノード同期中 {p}%',
    nodePublicLocalStarting: '公開ノードを使用中 · ローカルノード起動中',
    nodeLocalOnlySyncing: 'ローカルノード同期中 · 完了まで残高が不完全な場合があります',
    nodeLocalOnlyStarting: 'ローカルノード起動中…',
    localOnlyLabel: 'ローカルノードのみを使用',
    localOnlyHelp: '公開ノードには接続しません。ローカルノードの同期が完了するまで、残高と履歴が不完全な場合があります。',
    desktopNodeUnreachable: 'ローカルノードがまだ応答していません。Karlsen Desktop が自動的に再起動します。数秒後にもう一度お試しください。',
  },
  ko: {
    nodeLocal: '로컬 노드 (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: '공개 노드 사용 중 · 로컬 노드 동기화 {p}%',
    nodePublicLocalStarting: '공개 노드 사용 중 · 로컬 노드 시작 중',
    nodeLocalOnlySyncing: '로컬 노드 동기화 · 완료 전까지 잔액이 불완전할 수 있습니다',
    nodeLocalOnlyStarting: '로컬 노드 시작 중…',
    localOnlyLabel: '로컬 노드만 사용',
    localOnlyHelp: '공개 노드에 연결하지 않습니다. 로컬 노드 동기화가 끝날 때까지 잔액과 내역이 불완전할 수 있습니다.',
    desktopNodeUnreachable: '로컬 노드가 아직 응답하지 않습니다. Karlsen Desktop이 자동으로 다시 시작합니다. 몇 초 후 다시 시도하세요.',
  },
  pt: {
    nodeLocal: 'Nó local (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Usando nó público · nó local sincronizando {p}%',
    nodePublicLocalStarting: 'Usando nó público · nó local iniciando',
    nodeLocalOnlySyncing: 'Nó local sincronizando · o saldo pode estar incompleto até terminar',
    nodeLocalOnlyStarting: 'Nó local iniciando…',
    localOnlyLabel: 'Usar apenas o nó local',
    localOnlyHelp: 'Nunca se conecta ao nó público. Até o nó local terminar a sincronização, saldo e histórico podem estar incompletos.',
    desktopNodeUnreachable: 'O nó local ainda não responde. O Karlsen Desktop o reinicia automaticamente; tente novamente em alguns segundos.',
  },
  ru: {
    nodeLocal: 'Локальный узел (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Используется публичный узел · локальный узел синхронизируется {p}%',
    nodePublicLocalStarting: 'Используется публичный узел · локальный узел запускается',
    nodeLocalOnlySyncing: 'Локальный узел синхронизируется · баланс может быть неполным до завершения',
    nodeLocalOnlyStarting: 'Локальный узел запускается…',
    localOnlyLabel: 'Использовать только локальный узел',
    localOnlyHelp: 'Никогда не подключается к публичному узлу. Пока локальный узел не синхронизирован, баланс и история могут быть неполными.',
    desktopNodeUnreachable: 'Локальный узел пока не отвечает. Karlsen Desktop перезапустит его автоматически; повторите через несколько секунд.',
  },
  tr: {
    nodeLocal: 'Yerel node (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Public node kullanılıyor · yerel node senkronize oluyor %{p}',
    nodePublicLocalStarting: 'Public node kullanılıyor · yerel node başlatılıyor',
    nodeLocalOnlySyncing: 'Yerel node senkronize oluyor · bitene kadar bakiye eksik görünebilir',
    nodeLocalOnlyStarting: 'Yerel node başlatılıyor…',
    localOnlyLabel: 'Sadece yerel node kullan',
    localOnlyHelp: 'Public node’a hiç bağlanmaz. Yerel node senkronizasyonu bitene kadar bakiye ve geçmiş eksik görünebilir.',
    desktopNodeUnreachable: 'Yerel node henüz yanıt vermiyor. Karlsen Desktop onu otomatik olarak yeniden başlatır; birkaç saniye sonra tekrar deneyin.',
  },
  vi: {
    nodeLocal: 'Node cục bộ (Karlsen Desktop) ✓',
    nodePublicLocalSyncing: 'Đang dùng node công khai · node cục bộ đang đồng bộ {p}%',
    nodePublicLocalStarting: 'Đang dùng node công khai · node cục bộ đang khởi động',
    nodeLocalOnlySyncing: 'Node cục bộ đang đồng bộ · số dư có thể chưa đầy đủ cho đến khi xong',
    nodeLocalOnlyStarting: 'Node cục bộ đang khởi động…',
    localOnlyLabel: 'Chỉ dùng node cục bộ',
    localOnlyHelp: 'Không bao giờ kết nối node công khai. Cho đến khi node cục bộ đồng bộ xong, số dư và lịch sử có thể chưa đầy đủ.',
    desktopNodeUnreachable: 'Node cục bộ chưa phản hồi. Karlsen Desktop sẽ tự khởi động lại; hãy thử lại sau vài giây.',
  },
  zh: {
    nodeLocal: '本地节点（Karlsen Desktop）✓',
    nodePublicLocalSyncing: '正在使用公共节点 · 本地节点同步中 {p}%',
    nodePublicLocalStarting: '正在使用公共节点 · 本地节点启动中',
    nodeLocalOnlySyncing: '本地节点同步中 · 完成前余额可能不完整',
    nodeLocalOnlyStarting: '本地节点启动中…',
    localOnlyLabel: '仅使用本地节点',
    localOnlyHelp: '从不连接公共节点。本地节点同步完成前，余额和历史记录可能不完整。',
    desktopNodeUnreachable: '本地节点尚未响应。Karlsen Desktop 会自动重启它，请几秒后重试。',
  },
};

export function desktopText(lang: Lang, key: DesktopKey, progress?: number): string {
  const s = (TABLES[lang] ?? en)[key] ?? en[key];
  return progress == null ? s : s.replace('{p}', String(progress));
}

/**
 * Rough sync progress of the local node: its DAA score against the network's (from the
 * node the wallet is connected to). Capped at 99 until the node itself reports synced.
 */
export function localSyncPercent(localDaa?: bigint, networkDaa?: bigint): number | undefined {
  if (localDaa == null || networkDaa == null || networkDaa <= 0n) return undefined;
  const pct = Number((localDaa * 1000n) / networkDaa) / 10;
  return Math.max(0, Math.min(99, Math.floor(pct)));
}
