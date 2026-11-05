/**
 * Every user-visible string of the new shell, in one module, so
 * the language can be switched later in one place (`t` below, and `phaseWords` for the task
 * status table that lives next to taskPhase in packages/domain, design §9.3).
 *
 * Rules (design §1, owner's principles):
 * - The person gives only a goal. No copy, placeholder or example here may suggest typing
 *   pacing ("N 分钟", "每天 N 条"), reporting ("发完汇报给我"), communities or voice; nothing
 *   here names a pace: the task decides each account's pacing from the account's facts.
 * - Nothing here asks for an approval of an action on a site; 等你审阅 is only the upstream
 *   email/calendar draft review and proposals.
 * - Technical names (accounts, sites, communities, the action words a task reports)
 *   are data and never translated.
 * - Nothing here assumes a site: an account signs in to any site, by the AI, with its saved
 *   logins (credentials); nothing asks the person to sign in or to type a password anywhere but
 *   the credentials form.
 *
 * Pure: no react-native, so node:test can import it.
 */
import {
  type AgentTask,
  type IncidentKind,
  providerQuotaPattern,
} from "../../../../packages/domain/src/agent.ts";
import { signInStatusWordsZh } from "../../../../packages/domain/src/credentials.ts";
import {
  clockLabel,
  rhythmLabel,
  showsSteps,
  type TaskPhaseWords,
  taskPhaseWordsZh,
} from "../../../../packages/domain/src/task-phase.ts";

/** The task status table (等你回答 / 运行中 / 等待中 …); see packages/domain/src/task-phase.ts.
 * A step title the server wrote (the default plan steps, 「Understand the outcome」) reads in the
 * client's words (`serverText`), as in the task detail's step list; one the model wrote stays.
 * So does a failure the server wrote (a provider's quota answer). An open infrastructure
 * incident reads 「网络连不上（13:02 起）· 14:00 再试」 (fork, report line). */
export const phaseWords: TaskPhaseWords = {
  ...taskPhaseWordsZh,
  step: (current, total, what) => taskPhaseWordsZh.step(current, total, serverText(what)),
  stuckAt: (index, title) => taskPhaseWordsZh.stuckAt(index, serverText(title)),
  failed: (error, attempts) => taskPhaseWordsZh.failed(failureText(error), attempts),
  loopStopped: (error) => taskPhaseWordsZh.loopStopped(failureText(error)),
  incident: (kind, since, next) => zh.incidents.line(incidentWord(kind), since, next),
  // A finished run's summary with the server's not-confirmed line
  // reads that line first (`runNoteView`).
  result: (text) => {
    const view = runNoteView(text);
    return [view.unconfirmed, view.text].filter(Boolean).join("\n");
  },
};

/** A sentence someone else wrote, to be followed by our own punctuation: without its own full
 * stop (「…会不像它自己。」 → 「…会不像它自己」), so a card never reads 「。。」. */
const clause = (text: string) => text.trim().replace(/[。．.!！?？；;，,\s]+$/u, "");
/** A space before names that start with a Latin letter (「派给了 Nova」), none before Chinese
 * (「派给了创始人 Ann」). */
const lead = (names: string) => (/^[\u3400-\u9fff]/u.test(names) ? names : ` ${names}`);
const zh = {
  app: {
    // v1.2: the product is Yuki: 每个都有自己电脑的 AI 成员.
    name: "Yuki",
    /** The page's language (web: <html lang>), so screen readers and fonts read Chinese. */
    lang: "zh-CN",
    /** Browser tab title; n = 需要你 count across projects. */
    tabTitle: (n: number) => (n > 0 ? `(${n}) Yuki` : "Yuki"),
    opening: "正在打开工作台…",
    retry: "重试",
  },
  /** v1.5: the members' computer container, on the profile card (open core). */
  containerComputer: {
    title: "电脑",
    shared: "所有成员共用这一台电脑，文件在 /workspace。",
    running: "运行中",
    stopped: "已暂停（文件都在，要用时自动恢复）",
    unset: "没配置",
    unsetHint:
      "这台服务还没接电脑。用 docker compose 启动后会自动接上，见 docs/computer-container.md。",
    error: "连不上电脑",
    personDrives: "你正在操作，成员先等着",
    memberDrives: "成员在用",
    look: "看电脑",
    closeLook: "收起画面",
    drive: "接手",
    handBack: "交还",
    frame: "电脑的实时画面",
    viewOnly: "这里只能看；要动手请先点「接手」。",
    starting: "正在打开电脑…",
    /** 设置 → 电脑. */
    pause: "暂停",
    start: "启动",
    pausing: "正在暂停…",
    startingUp: "正在启动…",
  },
  /** v1.2: the profile card's own words. */
  memberCard: {
    /** v1.5: opens the member's computer (the live view; a paused one is started there). */
    openComputer: "看电脑",
    /** Opens the account sheet: time zone, language, logins, project, 启停. */
    settings: "账号设置",
  },
  /** v1.2: the small dialog that makes a member: a name, a shape, a color, an optional template. */
  newMember: {
    title: "新成员",
    name: "名字",
    namePlaceholder: "给她起个名字",
    shape: "形状",
    color: "颜色",
    preview: "头像预览",
    template: "从模板导入（可选）",
    templateNone: "不用模板",
    templateBlank: "不选模板就是一个空白成员，之后在对话里告诉她做什么。",
    templateRoutines: "例行：",
    templateApps: "要连接：",
    create: "创建",
    creating: "正在创建",
    created: (name: string) => `${name} 加入了`,
    shapes: {
      circle: "圆形",
      square: "方形",
      pill: "胶囊",
      hexagon: "六边形",
      cloud: "云朵",
    },
    colorLabel: (n: number) => `颜色 ${n}`,
    nameRequired: "名字必填",
    nameTooLong: (max: number) => `名字最多 ${max} 个字`,
    nameReserved: (name: string) => `「${name}」是保留名，换一个名字`,
    exists: (name: string) => `已经有叫「${name}」的成员了，换一个名字`,
    limit: (max: number) => `成员最多 ${max} 个，删掉一个才能再建`,
    faceInvalid: "形状或颜色不对，重新选一个",
    setupFailed: "成员已经建好，但模板没存全。再点一次创建，会接着存模板。",
  },
  /** v1.2: the dialog behind 新建群 in the contact list. A group is a project; a member is in one
   * group at a time, so choosing her from another group moves her. */
  newGroup: {
    title: "新建群",
    open: "新建群",
    name: "群名",
    namePlaceholder: "给这个群起个名字",
    members: "成员",
    pickHint: (min: number, max: number) =>
      `选 ${min} 到 ${max} 个成员，一个成员同一时间只在一个群里。`,
    picked: (n: number, max: number) => `已选 ${n} / ${max}`,
    full: (max: number) => `最多 ${max} 个，已经选满。取消一个才能再选。`,
    none: "还没有成员可选。先在左上角用 + 新成员。",
    free: "没在群里",
    inGroup: (group: string) => `在「${group}」`,
    moveNote: (group: string) => `选她会把她从「${group}」移过来，原来的群就少一个人。`,
    moveSummary: (n: number) => `${n} 个成员会离开原来的群，移到这个新群。`,
    create: "创建群",
    createdToast: (name: string) => `群「${name}」建好了`,
    tooFew: (min: number) => `至少选 ${min} 个成员`,
    tooMany: (max: number) => `最多 ${max} 个成员`,
    nameRequired: "群名必填",
    nameTooLong: (max: number) => `群名最多 ${max} 个字`,
    nameReserved: (name: string) => `「${name}」是保留名，换一个群名`,
    exists: (name: string) => `已经有叫「${name}」的群了，换一个群名`,
    limit: (max: number) => `群最多 ${max} 个，没法再建`,
    madeButMembers: (name: string) => `群「${name}」已经建好，但这些成员没进去：`,
    memberFailed: (member: string, why: string) => `${member}：${why}`,
    memberStuck: (member: string, why: string) =>
      `${member}：已经从原来的群出来了，但没能进新群（${why}）。`,
    retry: "接着移",
    emptyHint: "这个群现在没有成员。可以点「接着移」再试，或关掉后在群的右栏里加成员。",
  },
  /** v1.2: the group's right rail: its name and who is in it. */
  groupPane: {
    members: "群成员",
    rename: "改群名",
    renameLabel: "群名",
    save: "保存",
    renamed: (name: string) => `群名改成了「${name}」`,
    add: "加成员",
    adding: "选一个成员加进这个群",
    addFree: "没在群里的成员",
    addElsewhere: "在别的群里的成员（加进来会从那里移走）",
    nobodyToAdd: "没有可以加的成员了。",
    full: (max: number) => `这个群已经有 ${max} 个成员，满了。移出一个才能再加。`,
    remove: (name: string) => `把 ${name} 移出这个群`,
    removeLabel: "移出",
    added: (name: string) => `${name} 进群了`,
    moved: (name: string, group: string) => `${name} 从「${group}」移进来了`,
    removed: (name: string) => `${name} 移出了这个群，现在没在任何群里`,
    stuck: (name: string) => `${name} 已经从原来的群出来了，但没能进这个群，现在没在任何群里。`,
    unknownGroup: "另一个群",
    thisGroup: "这个群",
  },
  /** v1.2: the @ list under the chat box. */
  mention: {
    list: "提到谁",
    kinds: { member: "成员", group: "群", routine: "例行", skill: "技能", app: "应用" },
    here: "本群",
    main: "主成员",
    inGroup: (group: string) => `在「${group}」`,
  },
  /** Phase C (docs/web.md): words only the web app's frame uses (sidebar, top bar, ⌘K). */
  web: {
    search: "搜索",
    needsYou: "需要你",
    pages: "页面",
    projects: "群",
    newProject: "新群",
    openNav: "打开导航",
    members: "成员",
    details: "详情",
    more: "更多",
    location: "位置",
    spaceMenu: "切换空间、设置、退出",
    paletteHint: "搜群、成员、任务、汇报，或输入命令…",
    paletteEmpty: "没有找到",
    paletteGroups: {
      commands: "命令",
      projects: "群",
      accounts: "成员",
      tasks: "任务",
      spaces: "空间",
    },
    paletteKeys: { pick: "选择", open: "打开", close: "关闭" },
    tabs: { chat: "对话", needs: "需要你", members: "成员", more: "更多" },
    memberComputer: (name: string) => `看 ${name} 的电脑`,
    memberProfile: (name: string) => `${name} 的资料`,
    /** v1.4: Yuki's own card in her chat (her routines). */
    yukiDetail: "Yuki 的资料",
    yukiRole: "你的 AI 同事",
    signOut: "退出登录",
    switchSpace: (name: string) => `切换到 ${name}`,
    /** Back from a peeked account to the conversation's properties. */
    backToConversation: "回到对话详情",
    /** The project's crumb on its pages (凭据) and a page's own top-bar button pressed again:
     * back to the conversation. */
    toChat: "回到对话",
    /** Phase C: the platform
     * operator's own page, by task, most frequent first. */
    platform: {
      entry: "平台管理",
      // The task named here too, where the operator reads first.
      hint: "发邀请码、管空间、重置用户密码。只有平台管理员看得到。",
      tabs: {
        codes: "邀请码",
        /** 找用户 and each space's 成员与密码 are here. */
        spaces: "空间与用户",
        referrers: "介绍人",
        system: "系统",
      },
      /** ⌘K commands that open a tab. */
      commands: {
        codes: "生成邀请码",
        spaces: "新建空间",
        referrers: "管理介绍人",
        system: "系统健康：后台、异常、安全",
        /** Opens 空间与用户 at 找用户. */
        resetPassword: "重置用户密码",
      },
      /** 平台管理 → 邀请码: the sign-up settings under the codes. */
      settings: "注册设置",
      /** 空间: a refused sign-up's space. */
      rejected: "已拒绝的注册",
      /** The web page's own words. */
      // 空间: a sign-up still waiting (opened from 待开通; no 标记已付款 before that).
      waiting: "待开通的注册",
      /** A sign-up's state on a code's use line (邀请码 → a batch). */
      registrationStatus: { pending: "待开通", active: "已开通", rejected: "已拒绝" } as Record<
        string,
        string
      >,
      /** 系统 → 后台 with no heartbeat yet: what to do about it. */
      workerUnknownHint:
        "后台一启动就会每秒报一次心跳。一直没有，就是这台服务器上的后台没在跑：看服务器配置里后台任务有没有被关掉、单独的后台进程有没有启动，再点刷新。",
    },
  },
  common: {
    close: "关闭",
    back: "返回",
    more: "更多",
    cancel: "算了",
    /** A copy button whose copy the browser refused (an in-app browser, no permission): what
     * it copies is selected on the page instead. */
    copyFailed: "没复制上：内容已选中，请长按或右键手动复制。",
    save: "保存",
    saving: "正在保存…",
    refresh: "刷新",
    refreshed: "已刷新",
    retry: "再试",
    loading: "正在加载…",
    open: "打开",
    details: "详情",
    detailsArrow: "详情 ›",
    viewTask: "查看任务 ›",
    edit: "编辑",
    delete: "删除",
    confirm: "确认",
    sep: " · ",
    /** Between items of a list: 「任务甲、任务乙」. */
    listSep: "、",
    /** Between clauses: 「选区：…；口径：…」. */
    clauseSep: "；",
    /** Between a label and its value: 「选区：…」. */
    colon: "：",
    link: "↗",
    errorPrefix: "出错了：",
    unavailable: "暂时读不到，稍后再试",
  },
  header: {
    /** Header left on the workbench: project name + ▾ opens the switcher. */
    switchProject: (name: string) => `切换项目，当前 ${name}`,
    /** Red dot beside the project name: n things wait for you in other projects. */
    otherProjectsWaiting: (n: number) => `其他项目有 ${n} 件事等你`,
    backTo: (name: string) => `返回 ${name}`,
    accounts: "账号",
    credentials: "凭据",
    settings: "设置",
  },
  projects: {
    title: "群",
    column: "群",
    defaultName: "Yuki",
    accounts: (n: number) => `${n} 个成员`,
    unassignedAccounts: (n: number) => `${n} 个未分配`,
    current: "当前",
    newProject: "新群",
    newProjectName: "新群名称",
    newProjectPlaceholder: "例如 夏季计划",
    create: "创建群",
    rename: "改名",
    renameTo: (name: string) => `给 ${name} 改名`,
    saveName: "保存名称",
    remove: "删除",
    removeWarning: "删除这个群的对话、任务和默认桌面。账号保留，回到未分配。",
    removeConfirm: (name: string) => `输入「${name}」确认删除`,
    removeMismatch: "名称还没对上。",
    removeButton: "删除群",
    deleting: "正在删除… 上次没删完",
    retryDelete: "再试删除",
    limitReached: (max: number) => `已经有 ${max} 个群，删掉一个才能再建。`,
    countsSource: "群旁的数字是此刻等你、失败、运行、等待、排期的任务数；点进群看是哪些。",
    badgeNeeds: (n: number) => `等你 ${n}`,
    badgeFailed: (n: number) => `失败 ${n}`,
    badgeRunning: (n: number) => `运行 ${n}`,
    badgeWaiting: (n: number) => `等待 ${n}`,
    badgeScheduled: (n: number) => `排期 ${n}`,
    overviewUnavailable: "群数字暂时读不到",
    /** Accessible name of the ⋯ beside the project column's heading (opens the project panel). */
    manage: "改名、删除群",
    /** Accessible name of a project row. */
    switchTo: (name: string) => `切换到 ${name}`,
    /** Accessible name of a project that is being deleted. */
    deletingLabel: (name: string) => `${name} 正在删除`,
    /** validProjectName's errors. */
    nameRequired: "名称必填",
    nameTooLong: (max: number) => `名称最多 ${max} 个字`,
    nameReserved: (name: string) => `「${name}」是未分组的保留名，换一个`,
    /** A scoped request answered 404 for the project (deleted since it was selected). */
    gone: "这个群已经不在了，换一个。",
    /** A delete that stopped halfway; the reason follows. */
    deleteUnfinished: (detail: string) => `上次删除没完成：${detail}`,
  },
  strip: {
    needs: "等你",
    running: "运行",
    waiting: "等待",
    scheduled: "排期",
    failed: "失败",
    /** Nothing to show: grey line. */
    quiet: (next: string) => `全部安静 · ${next}`,
    quietNext: (clock: string) => `下一次 ${clock}`,
    quietNothing: "没有排期",
    openLive: "打开实况",
    /** One count in the strip's accessible name: 「等你 1」. */
    cell: (label: string, count: number) => `${label} ${count}`,
  },
  downBar: {
    /** Worker heartbeat older than 45 s: 「后台已停 3 分钟 · 最后心跳 14:44:02 · 任务不会推进」. */
    stopped: (duration: string, lastTick: string) =>
      `后台已停 ${duration} · 最后心跳 ${lastTick} · 任务不会推进`,
    /** The minutes of that duration (「3 分钟」, 「1 小时 20 分钟」; the rail's 「还剩 13 分」 stays). */
    minutes: (n: number) => `${n} 分钟`,
    neverSeen: "后台没有心跳 · 任务不会推进",
    /** GET /api/agent or /api/workspace fails; both are retried (the agent poll every 3 s, the
     * workspace after 5 s, doubling to once a minute, until it answers). */
    apiDown: "连不上服务器 · 正在重试",
    view: "查看",
  },
  /** The project's one system notice while the infrastructure keeps stopping
   * its runs (frame/strip.ts infraNoticeText); it goes by itself once runs work again. */
  infra: {
    notice: (what: string, since: string, tasks: number) =>
      `${what}${since ? `（${since} 起）` : ""} · ${tasks > 1 ? `${tasks} 个任务受影响，` : ""}会自己重试`,
    /** A task whose runs keep failing (packages/domain/src/standing.ts runTrouble): 「「X 的日常
     * 运营」连续 6 次没跑成：模型服务没返回内容 · 会自己重试」, and how many other tasks are held. */
    trouble: (title: string, count: number, why: string, others: number) =>
      `「${title}」连续 ${count} 次没跑成${why ? `：${why}` : ""} · ${others > 0 ? `另有 ${others} 个任务受影响，` : ""}会自己重试`,
  },
  threads: {
    title: "对话",
    main: "主聊天",
    mainHint: (project: string) => `${project} 的指挥频道`,
    side: "侧聊",
    sideNumbered: (n: number) => `侧聊 ${n}`,
    untitled: "未命名对话",
    newSide: "新侧聊",
    archived: "已归档",
    showActive: "显示进行中",
    noSide: "这个群还没有侧聊。侧聊里派的任务，汇报回到侧聊。",
    noArchived: "没有已归档的对话。",
    rename: "改名",
    saveName: "保存名称",
    nameLabel: "对话名称",
    archive: "归档",
    restore: "恢复",
    loadMore: "加载更多对话",
    retry: "重试",
    retryMain: "重新加载主聊天",
    inSide: (name: string) => `在侧聊：${name}`,
    defaultProjectHint: "给创始人派活在这里，群的活去群里",
    sideHint: "侧聊各有自己的上下文，群资料和记忆是共用的。",
    /** Accessible name of a conversation row. */
    open: (name: string) => `打开对话：${name}`,
    /** The side chat list could not be read. */
    listError: "对话列表读不到",
    /** A further page of side chats could not be read. */
    moreError: "更多对话没读到",
    /** Archive the main chat and start an empty one. */
    newMain: "开新主聊天",
    /** The entry's hint
     * in ⌘K / 更多 and the phone's 「+」, where the owner looks for 清空对话. */
    newMainHint: "清空对话：把现在的主聊天归档，从一条空的开始",
    newMainDone: "旧的主聊天已归档，在「已归档」里能找回",
    /** Another member started a new main chat: this page now shows it. */
    mainMoved: "主聊天换成了新的一条，旧的在「已归档」里",
    /** The name a replaced main chat gets when it has none: 「旧主聊天 · 到 2026-10-12」. */
    formerMainName: (day: string) => `旧主聊天 · 到 ${day}`,
  },
  /** Spaces, members, invite links and the operator's list of spaces. */
  spaces: {
    /** The row on top of the project column, only for someone in two or more spaces. */
    current: (name: string) => `空间：${name}`,
    switchLabel: (name: string) => `切换空间，当前 ${name}`,
    pickTitle: "选一个空间",
    pickHint: "你在好几个空间里。选一个打开，之后随时能在项目栏顶上切换。",
    none: "你还不在任何空间里。找空间的管理员要一个邀请链接。",
    loading: "正在读取你的空间…",
    loadFailed: "空间没读到",
    role: { admin: "管理员", member: "成员" } as Record<string, string>,
    /** Settings: the entry to the members page, and the operator's page. */
    members: "成员",
    allSpaces: "所有空间",
    membersTitle: (space: string) => `${space} · 成员`,
    you: "（你）",
    joinedAt: (day: string) => `${day} 加入`,
    spaceName: "空间名字",
    rename: "改名",
    saveName: "保存",
    inviteMember: "邀请成员",
    inviteAdmin: "邀请管理员",
    inviteHint: "把链接发给要加入的人。只能用一次，7 天后失效。",
    inviteFor: (role: string) => `邀请${role}的链接`,
    copy: "复制",
    copied: "已复制",
    expires: (when: string) => `${when} 失效`,
    revoke: "撤销",
    openInvites: "还没用的邀请链接",
    noOpenInvites: "没有还没用的邀请链接。",
    makeAdmin: "设为管理员",
    makeMember: "设为成员",
    removeMember: "移出空间",
    removed: (name: string) => `已把 ${name} 移出空间`,
    activityTitle: "最近的操作",
    noActivity: "还没有记录。",
    /** Who did it when no member is named (the platform made the space). */
    platform: "平台管理员",
    /** One line of the activity: who, what. */
    activity: (actor: string, what: string) => `${actor} ${what}`,
    actions: {
      "invite.create": (_s: string | null, d: string | null) =>
        `生成了一个邀请${d === "admin" ? "管理员" : "成员"}的链接`,
      "invite.revoke": (_s: string | null, d: string | null) =>
        `撤销了一个邀请${d === "admin" ? "管理员" : "成员"}的链接`,
      "member.join": (_s: string | null, d: string | null) =>
        `加入了空间（${d === "admin" ? "管理员" : "成员"}）`,
      "member.remove": (s: string | null) => `把 ${s ?? ""} 移出了空间`,
      "member.role": (s: string | null, d: string | null) =>
        `把 ${s ?? ""} 设为${d === "admin" ? "管理员" : "成员"}`,
      "space.rename": (s: string | null, d: string | null) =>
        `把空间名字从「${s ?? ""}」改成「${d ?? ""}」`,
      "project.create": (s: string | null) => `新建了群「${s ?? ""}」`,
      "project.rename": (s: string | null, d: string | null) =>
        `把群「${s ?? ""}」改名为「${d ?? ""}」`,
      "project.delete": (s: string | null) => `删除了群「${s ?? ""}」`,
      "account.create": (s: string | null) => `添加了账号 ${s ?? ""}`,
      "account.delete": (s: string | null) => `删除了账号 ${s ?? ""}`,
      "account.move": (s: string | null, d: string | null) =>
        d ? `把账号 ${s ?? ""} 放进了群「${d}」` : `把账号 ${s ?? ""} 移回未分组`,
      "thread.newMain": () => "开了新主聊天",
      "thread.delete": (s: string | null) => (s ? `删除了对话「${s}」` : "删除了一个对话"),
      "signup.join": (s: string | null) => (s ? `通过邀请码注册（${s}）` : "通过开放注册加入"),
      "platform.env": (s: string | null) => s ?? "配置了环境",
      "platform.activate": () => "开通了这个空间",
      "store.add": (s: string | null) => (s ? `从 ${s} 加开` : "加开的店铺"),
    } as Record<string, (subject: string | null, detail: string | null) => string>,
    /** The operator's page. */
    platformTitle: "所有空间",
    platformHint:
      "每个客户一个空间。新建后把第一位管理员的邀请链接发给客户；你自己不会进这个空间。",
    newSpace: "新建空间",
    newSpaceName: "新空间的名字",
    create: "新建",
    spaceRow: (members: number, day: string) => `${members} 位成员 · ${day} 建`,
    /** The operator's trial (no public free trial) and each space's plan. */
    trialDays: "试用天数（留空 = 内部空间，不计费）",
    trialDaysBad: "试用天数要是 1 到 90 的整数",
    billing: {
      internal: "内部空间 · 不计费",
      pending: "待付款",
      trial: (until: string) => `试用到 ${until}`,
      trialEnded: "只读 · 试用已到期",
      active: (stores: number, usd: number, until: string) =>
        `已订阅 ${stores} 个店铺 · ${usd} 美元/月 · 到 ${until}`,
      grace: (until: string) => `续费失败 · 宽限到 ${until}`,
      lapsed: "只读 · 订阅已过期",
      canceled: (until: string) => `已取消 · 用到 ${until}`,
      canceledEnded: "只读 · 订阅已取消",
    },
    firstAdminLink: (name: string) => `「${name}」第一位管理员的邀请链接`,
    /** A space nobody has joined yet: its first admin's link again. */
    newFirstAdminLink: "重新生成第一位管理员的链接",
    /** The invite link's page. */
    inviteTitle: (space: string) => `加入「${space}」`,
    inviteRole: (role: string) => `你将以${role}身份加入。`,
    join: (space: string) => `加入「${space}」`,
    signUpHint: "设一个用户名和密码，注册后直接进入这个空间。",
    signUp: "注册并加入",
    signedInAs: (name: string) => `当前登录：${name}`,
    otherAccount: "用别的账号注册",
    /** An existing account joins through the link (also when the stored session has ended). */
    haveAccount: "已有账号？登录后加入",
    noAccount: "没有账号？注册一个",
    signInHint: "用你已有的账号登录，登录后直接加入这个空间。",
    signInJoin: "登录并加入",
    /** A link that no longer works: the way into the app. */
    openApp: "打开 Yuki",
    inviteLoading: "正在读取邀请…",
    /** Who said it, above a member's message in a space of several members. */
    speaker: (name: string) => name,
  },
  /** Conversations still in CopilotKit's cloud (the bar above the chat). */
  cloudThreads: {
    failed: (pending: number, reason: string) =>
      pending > 0
        ? `以前的对话至少还有 ${pending} 个没搬回来：${reason}。下次启动会再搬。`
        : `以前的对话还没搬完：${reason}。下次启动会再搬。`,
    noKey: "以前的对话还在 CopilotKit 云上，没搬回来：配置里没有云 key",
  },
  live: {
    title: (project: string) => `${project} · 实况`,
    close: "关闭实况",
    /** Accessible name of the live rail (docked column or drawer). */
    label: "实况",
  },
  needs: {
    title: (n: number) => `需要你 (${n})`,
    /** Account-level flags (decision 4). */
    desktopError: "桌面出错",
    /** Facts only the owner can act on (credentials, docs/account-login.md). */
    wrongPassword: (site: string) => `${site} 密码不对`,
    needsCode: (site: string) => `${site} 要验证码`,
    needsOwner: (site: string) => `${site} 要你在桌面里接手一步`,
    /** After 我弄好了, until the AI records what it sees. */
    confirming: (site: string) => `正在确认 ${site} 的登录…`,
    /** No record came for too long after 我弄好了: back to the owner. */
    unconfirmed: (site: string) => `${site} 还没确认上，再点一次「我弄好了」或让她再看`,
    suspended: (site: string) => `${site} 号被封`,
    noLogin: (site: string) => `缺 ${site} 登录`,
    /** An account of a project (or the founder) with no long-term goal and
     * no open job: nothing makes it act (AccountLoops.wanted). */
    idle: "没在经营：给它一个长期目标或派活",
    /** The idle account's buttons: its goal field (the account detail), the chat prefilled. */
    setGoal: "定长期目标",
    dispatch: "在聊天里派活…",
    /** A paused standing loop's button. */
    resume: "恢复",
    /** The project's own logins (its default desktop). */
    projectFact: (text: string) => `本群：${text}`,
    /** The project item's heading (its default desktop's logins, used by no account). */
    projectTitle: "本群的登录",
    addLoginFor: (site: string) => `去添加 ${site}`,
    openDefaultDesktop: "打开群默认桌面",
    replaceLogin: "去凭据页更换",
    addLogin: "去添加",
    openDesktop: "打开这个号的桌面",
    reviewSub: (title: string, expires: string) => `${title} · ${expires}后过期`,
    review: "审阅",
    answer: "回答",
    answerPlaceholder: "把缺的信息写在这里…",
    send: "发送回答",
    retry: "重试",
    continueNow: "立即继续",
    /** What 立即继续 answers for a task that stopped, before the report line, on a run without a
     * completion call (it asks to be told to go on); sent as the task's answer. */
    continueAnswer: "继续，按原来的计划做",
    /** One-line receipts after acting. */
    receiptAnswered: "你回答了，任务继续",
    receiptRetried: "你点了重试，任务重新运行",
    receiptContinued: "你点了立即继续，跳过剩余等待",
    receiptAt: (text: string, clock: string) => `${text} · ${clock}`,
    openAccount: "看账号",
    /** The answer text sent when the person only filled the requested fields (the server needs
     * a non-empty answer). */
    fieldsAnswer: "已按要求填好信息",
    /** A review whose proposal has already expired. */
    reviewExpired: (title: string) => `${title} · 已过期，没有执行`,
    /** The same, when the row already shows the review's title (reviewLine `shown`). */
    reviewExpiresIn: (expires: string) => `${expires}后过期`,
    reviewExpiredShort: "已过期，没有执行",
    /** A chat-started task's review waits with no expiry. */
    reviewWaiting: "等你决定",
    /** A draft (an email to people) waits for 发送 or 不发. */
    reviewDraft: "草稿，等你发送",
    /** Undeclined, it is sent when the window ends. */
    /** The task's bound account is not one of this project's accounts any more. */
    accountGone: "账号已不在本群",
    /** Web 需要你 page: the line when nothing waits, and how many things wait (under the title). */
    inboxEmpty: "没有要你处理的事",
    inboxSub: (n: number) => `${n} 件等你处理`,
    /** The whole space's 需要你 page, grouped by project: a group's head (「Yuki · 当前 · 2」),
     * an other project's row (its kind, the project and the account) and its one button, which
     * opens that project (where the row has every action). */
    inboxGroup: (name: string, n: number, current: boolean) =>
      current ? `${name} · 当前 · ${n}` : `${name} · ${n}`,
    otherKind: {
      input: "等你回答",
      approval: "等你审阅",
      fail: "停了，等你处理",
      review: "等你审阅",
      account: "账号要你处理",
      project: "群的登录要你处理",
      unknown: "一件事等你处理",
    } as Record<string, string>,
    otherLine: (parts: readonly string[]) => parts.filter(Boolean).join(" · "),
    openProject: "去处理",
    openProjectHint: (name: string) => `切到「${name}」处理`,
    /** The ✕ of a non-red banner (web): hidden for this visit, it stays in 需要你. */
    dismiss: "先不提醒（仍在「需要你」里）",
    /** The answer box of a 需要你 row, folded / unfolded. */
    expand: "展开",
    collapse: "收起",
  },
  accountsRail: {
    title: (n: number) => `账号 (${n})`,
    unassignedTitle: (n: number) => `未分配账号 (${n})`,
    join: "加入",
    empty: "还没有账号。点「加入」从未分配账号里挑，或去「账号」新建。",
    now: "此刻",
    pace: "节奏",
    next: "下次",
    idle: "空闲",
    more: (n: number) => `+${n}`,
    desktop: (word: string) => `桌面 ${word}`,
    nextWait: (clock: string) => `${clock} 继续（等待）`,
    /** 下次 on the account row: the time only (the task's rhythm is in the task). */
    nextSched: (clock: string) => clock,
  },
  flags: {
    desktopError: "桌面出错",
    /** No long-term goal and no open job. */
    idle: "没在经营",
    defaultDesktop: "跑在默认桌面",
  },
  desktop: {
    missing: "未创建",
    stopped: "已暂停",
    running: "运行中",
    error: "出错",
    stoppedKept: "已暂停（保留登录和文件）",
    /** v1.5: a member's 电脑 row, the computer's real state. */
    card: {
      running: "开着",
      stopped: "暂停（要用时自动打开，登录和文件都在）",
      missing: "还没开过（要用时自动打开）",
      error: "出错",
    },
    /** Why a computer is in error, in plain words (the server's message stays in its log). */
    reasons: {
      disabled: "云电脑还没开通",
      noCredit: "云电脑服务额度用完了，平台正在处理",
      timedOut: "云电脑没有及时响应，稍后会再试",
      isolation: "这台电脑的归属对不上，已拒绝连接",
      settings: "这台电脑的设置读不出来",
      unknown: "云电脑暂时连不上，稍后会再试",
    },
    /** The chat's desktop cards (use_desktop). */
    title: "桌面",
    using: "正在用桌面…",
    stepFailed: "这一步没成功",
    step: "桌面操作",
    offline: "桌面没开。启动后才能看到画面；之前开着的程序会关掉。",
    screenshot: "桌面最近一次截图",
    /** Phone: the collapsed one-line card opens the full card. */
    expand: "展开桌面",
    collapse: "收起桌面",
    /** A reply's consecutive desktop steps are
     * one block: the live line while it works, the one line it folds to when the reply ends. */
    operating: (who: string, step: number, what: string) =>
      `正在 ${who} 的桌面上操作 · 第 ${step} 步 · ${what}`,
    operatingHere: (step: number, what: string) => `正在桌面上操作 · 第 ${step} 步 · ${what}`,
    didSteps: (steps: number) => `在桌面上做了 ${steps} 步`,
    stepsFailed: (steps: number) => `${steps} 步没成功`,
    expandSteps: "展开步骤",
    collapseSteps: "收起步骤",
    /** Each step kind in plain words (use_desktop's actions, and the desktop browser opened from
     * a command); never the receipt's `desktop screenshot (0, 0) down 3`. */
    steps: {
      screenshot: "看一眼屏幕",
      left_click: "点击",
      double_click: "双击",
      right_click: "右键点击",
      mouse_move: "移动鼠标",
      type: "输入文字",
      send: "发送",
      click_control: "点控件",
      key: "按键",
      scroll: "滚动页面",
      wait: "等一下",
      open_page: "打开网页",
      pages: "看打开的网页",
    },
    /** 「按 ctrl+l」: key names are safe to show (the schema restricts them); typed text never is. */
    keyNamed: (keys: string) => `按 ${keys}`,
    /** 「点「回复」」, the control's name as the page labels it. */
    clickNamed: (name: string) => `点「${name}」`,
    scrollTo: { up: "向上滚动", down: "向下滚动", left: "向左滚动", right: "向右滚动" },
  },
  tasksRail: {
    title: "任务",
    newTask: "新任务",
    needsAbove: (n: number) => `需要你的 ${n} 个任务在上方「需要你」。`,
    empty: "没有在跑或排期的任务。",
    paused: (n: number) => `已暂停 (${n})`,
    ended: (n: number) => `最近 24 小时结束 (${n})`,
    pause: "暂停",
    resume: "恢复",
    runNow: "立即运行",
    continueNow: "立即继续",
    retry: "重试",
    changeInterval: "改间隔",
    stopRepeating: "停止重复",
    paused_toast: "已暂停",
    resumed_toast: "已恢复",
    ranNow: "已开始运行",
    continued: "跳过剩余等待，任务继续",
    /** A rail task card's state while it waits: 「明天 00:00 继续」. */
    resumesAt: (clock: string) => `${clock} 继续`,
  },
  notes: {
    title: "群资料",
    summary: (memories: number, sides: number) => `${memories} 条记忆 · ${sides} 个侧聊`,
    briefLabel: "群资料：这个群是什么、相关链接、不能说什么",
    briefPlaceholder: "例如：这个群要做的事、相关链接；不能说…",
    briefSave: "保存资料",
    briefSaved: "已保存",
    briefUpdated: (clock: string) => `更新于 ${clock}`,
    memories: "记忆",
    noMemories: "还没有记忆。",
    memoriesHint:
      "这里记的是群事实、你的指令，和系统自己拟的人设、口径与节奏（标「系统拟」）。要改，直接在聊天里说。",
  },
  chat: {
    /** A reply's steps, folded under what it did. */
    replySteps: (steps: number) => `过程 · ${steps} 步`,
    /** The line under the conversation for a background task reporting here (v0.6). */
    statusLine: {
      running: (title: string, what: string) => `后台正在做「${title}」：${what}`,
      waiting: (title: string, what: string) => `「${title}」${what}`,
    },
    /** The assistant is named as it speaks here (Yuki, or the project's
     * 运营专员: group-state.ts `useOpsName`), never the product's name. */
    placeholder: (assistant: string) => `跟 ${assistant} 说…`,
    /** v1.2 design: a member's own conversation is addressed to them. */
    toMember: (name: string) => `给 ${name} 发消息`,
    /** v1.2: the first message waits until her desktop is the one this conversation uses. */
    pinningDesktop: "正在接上她的电脑",
    /** v1.2 design: the group composer says a message here can be handed to someone. */
    groupPlaceholder: "在群里说，@ 谁就交给谁",
    openMember: (name: string) => `去 ${name} 的对话`,
    /** v1.2: while a reply is running, a new sentence cuts it off and 停 only stops. */
    interruptHint: "发一句就打断；只打「停」就停",
    connecting: "正在连接…",
    loadingConversation: "正在加载对话…",
    conversationUnavailable: "对话暂时打不开",
    send: "发送",
    stop: "停止回复",
    working: (assistant: string) => `${assistant} 正在处理`,
    latest: "回到最新",
    retryResponse: "重新回复",
    /** The server is trying the reply once more after the model service
     * failed mid-reply (reply-retry.ts); the desktop step it was on is kept. */
    retrying: "服务暂时出错，正在重试…",
    /** That retry failed too: the reply ended, 重新回复 runs the turn again. */
    serviceFailed: "服务暂时出错，重试也没成功。稍等一下再点重新回复。",
    retryLoad: "重新加载对话",
    retrySave: "重新保存对话",
    queued: "下一条",
    onHold: "暂缓发送",
    keepOpen: "发出前请保持页面打开",
    sendQueued: "发送暂缓的消息",
    removeQueued: (text: string) => `移除待发消息：${text}`,
    loadError: (detail: string) => `对话加载失败，已保存的消息没有改动。${detail}`,
    saveError: (detail: string) => `对话没能保存：${detail}`,
    /** The stop button failed (the server's message follows). */
    stopError: (detail: string) => `没能停止回复：${detail}`,
    /** A send attempted before the conversation finished loading. */
    notReady: "对话还没准备好，稍等一下。",
    /** A choice (present_choices) picked before the conversation can take it. */
    choiceNotReady: "对话还不能接收这个选择，稍等一下。",
    /** Retrying a choice while a reply or queued messages are still pending. */
    waitForReply: "等当前回复结束再重试。",
    /** A queued choice removed from the outbox. */
    choiceRemoved: "这个选择已从待发列表移除。",
    /** A reply's request did not get through to the chat service (CopilotKit's cloud, or the
     * way there); the server already resent it while it could, so this one is over. */
    transportFailed: "聊天服务暂时连不上，稍后再发一次。",
    /** The server refused the request because this person sent too many in the last minute. */
    tooManyRequests: "刚才的请求太多了，过一分钟再发一次。",
    /** Loading the conversation did not get through to the chat service; it is tried again. */
    transportRetrying: "聊天服务暂时连不上，我在重试。",
    /** 重新回复 refused because another reply still holds the conversation. */
    threadBusy: "上一条回复还没结束，等它结束再点重新回复。",
    /** Without rich threads (no conversation list): the latest results under the chat. */
    recentResults: "最近结果",
    hideRecentResults: "收起最近结果",
    /** Choosing an operating account where there is no conversation. */
    noConversation: "这里没有对话，不能选操作账号。",
    /** Web block timeline: the day divider above the first block of a day. */
    day: {
      today: "今天",
      yesterday: "昨天",
      date: (month: number, day: number) => `${month}月${day}日`,
    },
    /** The chip that shows or hides what a report posted (its quote). */
    quote: "原文",
    /** A block's hover actions. */
    openTask: "打开任务",
    earlier: (n: number) => `更早 ${n} 条`,
    hideEarlier: "收起更早",
    /** The person's own messages, for a screen reader (the block has no name line). */
    you: "你",
  },
  /** Names of the server tool cards in chat (agent_status, task_events, create_goal, watch_page,
   * remember_fact). */
  tools: {
    progress: "进度",
    taskEvents: "任务动态",
    goal: "目标",
    watch: "网页监控",
    memory: "记忆",
    saving: (name: string) => `正在保存${name}…`,
    waiting: "等服务器回应…",
    savedInRail: "已保存，在右侧实况栏里能看到。",
    view: (name: string) => `看${name} ›`,
    /** The delegated task's results (files, documents) could not be loaded. */
    reloadResults: "重新读取任务结果",
    /** redirect_task's card (fork, report line): which task got the instruction, and its state. */
    redirect: "已转告任务",
    redirecting: "正在转告任务…",
    /** The card's title when the instruction did not reach the task; the reason is shown only
     * when it is a known one (in Chinese, `serverText`). */
    redirectFailed: "没能转告任务",
    redirectLine: (title: string, state: string) => `${title} · ${state}`,
    /** pause_task / resume_task's cards (fork, pause from chat): the task the person paused or
     * resumed in the chat, and its state now. */
    pause: "已暂停任务",
    pausing: "正在暂停任务…",
    pauseFailed: "没能暂停任务",
    resume: "已恢复任务",
    resuming: "正在恢复任务…",
    resumeFailed: "没能恢复任务",
  },
  /** The chat's search_web and browse_web cards (the product research step). */
  webTools: {
    searching: "正在搜索网页…",
    searchStopped: "搜索已停止",
    searchFailed: "搜索没成功",
    searchUnreadable: "搜索结果读不出来。",
    found: (n: number) => `找到 ${n} 个来源`,
    noSources: "没找到来源",
    truncated: "部分结果或摘要没有显示。",
    sourceOpenFailed: "打不开这个来源。",
    browser: "浏览器",
    reading: "正在读网页…",
    browsingPaused: "浏览已暂停",
    readFailed: "网页没读成",
    openingPage: "正在打开网页",
    pageRead: "网页已读",
    noPage: "浏览器没有返回网页，请再说一次。",
    preview: (title: string) => `浏览器预览：${title}`,
    movedOn: "这页已读过，浏览器已经去了别的页面。",
    sessionSaved: "浏览会话已保存，接管时会重新打开。",
    sessionError: "浏览会话断了，接管时会重新连接。",
    previewUnavailable: "预览暂时看不到，仍可以接管。",
    connecting: "正在连接已保存的会话…",
    takeControl: "接管",
    reconnect: "重新连接预览",
  },
  /** The chat's search_mail and read_mail_thread cards (upstream mail tools). */
  mailTools: {
    paused: "读邮件已暂停",
    checking: "正在查收件箱…",
    reading: "正在读邮件…",
    unreadableSearch: "邮箱返回的结果读不出来。",
    found: (n: number, atLeast: boolean) => `找到${atLeast ? "至少 " : " "}${n} 封邮件`,
    noMatches: "没有符合的邮件",
    unreadable: "这封邮件显示不了。",
    empty: "这个会话里没有邮件。",
    meta: (n: number) => `邮件 · ${n} 封`,
    excerpt: "只显示了这个会话的一部分。",
    open: "打开邮件",
  },
  /** The chat's present_choices card. */
  choices: {
    preparing: "正在准备选项…",
    unreadable: "选项显示不了，请重试。",
    chooseExhibit: "选这个方案",
    chooseOption: "选这个",
    chooseLabel: (caption: string, label: string, position: number) =>
      `${caption}：${label}（第 ${position} 个）`,
    sample: "示例 · 预设的决定",
    live: "实时 · 模型的决定",
    preferred: (label: string) => `上次倾向：${label}`,
    earlier: "较早的选项",
    submitted: "已提交选择",
    retry: "重试这个选择",
    source: (title: string) => `来源：${title}`,
    noConversation: "先打开一个对话再选。",
    noConversationRetry: "先打开一个对话再重试。",
    /** The user's own message after a choice: 「已选：方案 A」. */
    selected: (label: string) => `已选：${label}`,
    unavailable: "这个选择已失效",
  },
  /** 等你审阅: the upstream email / calendar draft review (prepare_email, prepare_event; never an
   * action on a site). The person's decision is the upstream logic, unchanged. */
  review: {
    pendingTitle: "最后看一眼",
    /** v1.4 (docs/apps.md): a call of a connected app, a Slack message. */
    appName: "应用",
    appTool: "操作",
    appArguments: "参数",
    slackChannel: "频道",
    slackText: "内容",
    slackThread: "回复",
    slackThreadOf: "线程",
    sampleHint: "这个操作只留在本地示例工作台里。",
    liveHint: "这是即将对你已连接账号执行的操作，确认前请核对。",
    kinds: {
      "email.send": "发送邮件",
      "calendar.create": "新建日程",
      "calendar.update": "修改日程",
      "calendar.delete": "删除日程",
      "app.call": "调用应用",
      "slack.send": "发送 Slack 消息",
    } as Readonly<Record<string, string>>,
    statuses: {
      awaiting_review: "等你审阅",
      executing: "正在执行",
      succeeded: "已完成",
      failed: "失败",
      outcome_unknown: "结果不明",
      denied: "没执行",
      cancelled: "已取消",
      expired: "已过期",
    } as Readonly<Record<string, string>>,
    account: "账号",
    to: "收件人",
    cc: "抄送",
    bcc: "密送",
    subject: "主题",
    attachments: "附件",
    noAttachments: "没有附件",
    attachmentVersion: (name: string, version: string) => `${name} · 版本 ${version}`,
    none: "无",
    event: "日程",
    starts: "开始",
    ends: "结束",
    endsExclusive: (date: string) => `${date}（不含当天）`,
    timeZone: "时区",
    allDay: "全天",
    yes: "是",
    no: "否",
    location: "地点",
    attendees: "参加者",
    justYou: "只有你",
    notes: "备注",
    calendar: "日历",
    deleteWarning: "这会删除这个日程，参加者可能会收到通知。",
    inviteWarning: "参加者可能会从你已连接的日历收到邀请或更新。",
    expires: (when: string) => `审阅在 ${when} 过期。你的同意只对上面显示的内容有效。`,
    /** A review past its expiry: no approve buttons, only this (details-state useReview). */
    expiredHint: "这次审阅已过期，没有执行，也不能再同意。需要的话让它重新准备一份。",
    alwaysAllow: "总是允许",
    /** The card's buttons: an action, and a draft (a message to people). */
    allowOnce: "允许一次",
    refuse: "拒绝",
    draft: "草稿",
    sendDraft: "发送",
    noSend: "不发",
    /** An expired card says so, and 总是允许 there only saves the rule. */
    expiredNote: "已过期，没有执行",
    expiredAlwaysHint: "总是允许只保存这条规则，不会执行这次已过期的操作。",
    autoByReview: (reason: string) => `动作审查放行：${reason}`,
    askedBy: (reason: string) => `需要你确认：${reason}`,
    alwaysAsk: "以后都先问我",
    ruleSaved: (mode: "always" | "ask", scope: "account" | "project") =>
      `${mode === "always" ? "以后这类直接发出" : "以后这类都先问你"}（${scope === "account" ? "这个号" : "本群"}）`,
    /** The expired review's one button: it leaves 需要你. */
    dismissExpired: "知道了，移出「需要你」",
    approveLocal: "在本地同意",
    approveSend: "同意并发送",
    approveChange: "同意这项修改",
    edit: "改一下再说",
    deny: "不执行",
    done: "好",
    missingEvent: "找不到这个日程，请到日历里重新打开。",
    /** The sample workspace's result line of a sent reply. */
    savedLocally: "回复已存进本地的「已发送」。",
    /** The check of what the email says about you (claim-check.ts). */
    unsupportedTitle: "没有来源的说法",
    unsupportedHint:
      "信里这些关于你或你业务的说法，在群资料、记忆和你说过的话里都找不到。属实再发；不属实就点「改一下再说」。",
    uncheckedTitle: "未核对",
    uncheckedHint: "信里关于你和你业务的说法这次没能核对来源，发之前请自己看一遍。",
  },
  /** Why an email or event form was not accepted, field by field (details.tsx issueList). */
  formIssues: {
    fields: {
      to: "收件人",
      cc: "抄送",
      bcc: "密送",
      subject: "主题",
      body: "正文",
      title: "标题",
      start: "开始",
      end: "结束",
      timeZone: "时区",
      location: "地点",
      attendees: "参加者",
      description: "备注",
    } as Readonly<Record<string, string>>,
    form: "表单",
    required: "不能空着",
    addOne: "至少填一个",
    tooLong: "太长了",
    invalid: "格式不对",
    line: (field: string, text: string) => `${field}：${text}`,
  },
  /** An email conversation (details.tsx MailDetail). */
  mailSheet: {
    count: (n: number) => `这个对话里有 ${n} 封邮件`,
    loading: "正在读取这个对话…",
    to: (list: string) => `收件人：${list}`,
    attachment: (pages: number) => `${pages} 页 · PDF 附件`,
    openAttachment: "打开附件",
    reload: "重新读取",
    reply: "写回复",
  },
  /** Writing an email: a reply, a new message, or 改一下再说 on a reviewed draft. */
  emailSheet: {
    replyTitle: "写回复",
    newTitle: "新邮件",
    from: (email: string) => `用 ${email} 发 · 草稿只存在 Yuki 里`,
    savedPrivately: "草稿只存在 Yuki 里",
    to: "收件人",
    cc: "抄送",
    bcc: "密送",
    optional: "可不填",
    subject: "主题",
    subjectPlaceholder: "这封邮件说什么？",
    body: "正文",
    bodyPlaceholder: "写正文…",
    attachments: "附件",
    attachment: (name: string, kb: number) => `${name} · ${kb} KB`,
    review: "审阅邮件",
    saveDraft: "存草稿",
    draftSaved: "草稿已存进 Yuki。",
    reviewHint: "发出前，你会再核对一遍收件人、正文和附件。",
  },
  /** Creating or changing a calendar event: a new one, or 改一下再说 on a reviewed change. */
  eventSheet: {
    editTitle: "修改日程",
    newTitle: "新日程",
    editHint: "改好后再审阅一遍修改。",
    newHint: "在日历里新建一个日程。",
    title: "日程标题",
    titlePlaceholder: "这段时间做什么？",
    allDay: "全天",
    starts: "开始",
    ends: "结束",
    allDayEndHint: "结束日期填最后一天的后一天。",
    timeZone: "时区",
    location: "地点或会议链接",
    optional: "可不填",
    attendees: "参加者",
    attendeesPlaceholder: "邮箱地址，用逗号隔开",
    notes: "备注",
    notesPlaceholder: "还有什么要记下的？",
    overlaps: "这个时间和别的日程冲突",
    reviewChanges: "审阅修改",
    reviewEvent: "审阅日程",
    reviewDeletion: "审阅删除",
  },
  /** The date and time inputs of the event form. */
  dateFields: {
    date: (label: string) => `${label}日期`,
    time: (label: string) => `${label}时间`,
    datePlaceholder: "YYYY-MM-DD",
    timePlaceholder: "HH:MM（24 小时制）",
    badTimeZone: "时区不对，请填一个有效的时区。",
  },
  /** A PDF (details.tsx FileDetail): a task's result, a mail attachment, a desktop export. */
  fileSheet: {
    meta: (pages: number, kb: number, source: string) => `${pages} 页 · ${kb} KB · ${source}`,
    openDownload: "打开 / 下载",
    saveShare: "保存或分享",
    noSharing: "这台设备不能分享文件。",
    attach: "附到邮件里",
    fillTitle: "填写这份表格",
    fillHint: "在下面填好。保存会另存一份副本，原件不动。",
    unsupported: (name: string) => `${name} · 这种字段还不能填`,
    saveFilled: "保存填好的副本",
    added: (date: string) => `添加于 ${date}`,
    filledCopy: "填好的副本",
    /** Where a file came from, as the server wrote it (apps/server: files.import callers). */
    sources: {
      uploaded: "你上传的",
      browser: (id: string) => `浏览器下载 · ${id}`,
      filled: (name: string) => `由 ${name} 填写生成`,
      /** name null = the project's default desktop. */
      computer: (name: string | null, path: string) =>
        name ? `${name} 的桌面：${path}` : `默认桌面：${path}`,
    },
  },
  /** The PDF reader inside a file sheet. */
  pdf: {
    previous: "上一页",
    next: "下一页",
    zoomOut: "缩小",
    zoomIn: "放大",
    frame: "PDF 阅读器",
    toolbarHint: "下载或打印请用阅读器自己的工具栏。",
  },
  /** A browser session (details.tsx BrowserDetail), opened from the chat. */
  browserSheet: {
    statuses: {
      idle: "空闲",
      active: "已连接",
      closed: "已关闭",
      error: "出错",
    } as Readonly<Record<string, string>>,
    subtitle: (status: string, time: string) => `${status} · ${time} 更新`,
    address: "网址",
    go: "打开",
    reopen: "重新打开",
    reconnect: "重新连接",
    retryConnection: "重试连接",
    connecting: "正在连接浏览器…",
    closedTitle: "这个会话已关闭",
    closedDetail: "登录状态和下载都还在，重新打开就能接着用。",
    noPreviewTitle: "看不到预览",
    noPreviewDetail: "重新连接，接着用保存好的浏览器资料。",
    openWindow: "在新窗口打开浏览器",
    refreshConnection: "刷新连接",
    importPdfs: "导入下载的 PDF",
    imported: (n: number) => `${n} 个下载的 PDF 已加进文件。`,
    noneImported: "这个会话里没有新的 PDF 下载。",
    closeSession: "关闭会话",
    console: "远程浏览器画面",
  },
  /** Sign-in and first-run setup. */
  auth: {
    welcome: "欢迎使用 Yuki",
    tagline: "每个项目一个工作台。",
    signIn: "登录",
    signingIn: "正在登录…",
    username: "用户名",
    password: "密码",
    missing: "请输入用户名和密码。",
    setupTitle: "创建管理员账号",
    setupHint: "这个工作台还没有账号。设一个用户名和密码；设置码印在服务器日志里。",
    usernamePlaceholder: "字母、数字、点、短横线、下划线",
    passwordPlaceholder: (min: number) => `至少 ${min} 位`,
    repeatPassword: "再输一次密码",
    setupCode: "设置码",
    setupCodePlaceholder: "在服务器日志里",
    createAccount: "创建账号",
    usernameInvalid: "用户名：1 到 32 个字符，只能用字母、数字、点、短横线或下划线。",
    passwordTooShort: (min: number) => `密码至少 ${min} 位。`,
    passwordsDiffer: "两次输入的密码不一样。",
    codeMissing: "请输入服务器日志里的设置码。",
    unreachable: "连不上服务器。",
    tryAgain: "再试一次",
    serverHint: (url: string) => `请确认 Yuki 服务器在 ${url} 上运行。`,
  },
  /** The chat's file card (a task's filled PDF). */
  files: {
    open: (name: string) => `打开 PDF：${name}`,
    pages: (n: number) => `${n} 页 · 点开阅读`,
    kind: "PDF",
  },
  composer: {
    /** Under an empty input, what a request may say;
     * never a form, never required. */
    dispatchHint:
      "派活可以说：要什么结果 · 看哪些来源 · 哪些不能碰 · 交付成什么 · 停在哪等你看。一句话写不全也行，缺的号自己补或问你一句。",
    operator: (name: string) => `操作账号：${name}`,
    operatorNone: "操作账号：不指定",
    operatorStale: "这个账号已不在本群，请重选",
    operatorLoading: "操作账号：…",
    operatorTitle: "操作账号",
    operatorHint: "这个对话里，Yuki 用哪个账号的桌面操作。只列本群账号。",
    operatorNoneOption: "不指定",
    operatorNoneHint: "只聊天，不操作任何账号",
    plus: "更多：新后台任务、选操作账号",
    plusTitle: "更多",
    plusNewTask: "新后台任务",
    plusNewTaskHint: "要准确指定账号和重复周期时用",
    plusOperator: "选操作账号",
    plusOperatorHint: "这个对话用哪台账号桌面",
    /** The conversation switcher and the project's notes moved into 「+」. */
    plusThreads: "对话",
    plusThreadsHint: "切换或新建侧聊",
    plusNotes: "群资料",
    plusNotesHint: "这个群是什么、相关链接、记忆",
    /** Prefilled when 在聊天里派活… is pressed in an account's detail. */
    dispatchPrefill: (account: string) => `用 ${account} `,
    /** Web: the text box's hint (Enter sends). */
    newLine: "Shift+Enter 换行",
  },
  empty: {
    /** Design §6.9: per project; only a goal, never pacing or reporting. */
    title: (project: string) => `${project} 还没开始`,
    noAccounts: "这个群还没有成员。",
    body: "一句话就行：用哪个号做什么，什么目标都行，比如介绍一款产品、经营一个人设。怎么做、节奏由系统自己拟，先汇报一张「计划」卡再开始；它自己查不到的才会问你。谈定的内容会记进群资料。",
    joinAccount: "加一个成员进来 ›",
    groupBody: "说清要什么结果，@ 谁就交给谁。不 @ 时由群里合适的成员接。",
    prefillSuggestion: "先说说要什么结果 ›",
    prefillText: "帮我 ……",
    defaultTitle: "Yuki",
    defaultBody: "告诉 Yuki 你要它做什么。需要帮手时，在左上角加成员。",
    openAccounts: "打开账号 ›",
    /** Web: the same place, now the new-member dialog. */
    newMember: "新建一个成员 ›",
    /** v1.2: an open member with nothing in her conversation yet. */
    memberBody: (name: string) => `${name} 做的每件事回到这里。要派活，在下面给 ${name} 发消息。`,
  },
  taskCard: {
    header: (clock: string) => `任务 · 委派于 ${clock}`,
    now: "现在：",
    meta: (rhythm: string, step: string) => [rhythm, step].filter(Boolean).join(" · "),
    step: (current: number, total: number) => `第 ${current}/${total} 步`,
    runs: (n: number) => `已跑 ${n} 轮`,
    /** An account's task that does not repeat: it goes on, run after run, until it is done or
     * the person stops it (「一次性」 read as if it ran once). */
    ongoing: "持续进行",
    saving: "正在建任务…",
    missing: "这个任务已经不在了。",
  },
  /** An account's standing loop is titled
   * 「<name> 的日常运营」; one the server titled before reads the same (`taskTitleText`). */
  taskTitle: {
    loop: (name: string) => `${name} 的日常运营`,
    oldLoopPrefix: "经营 · ",
  },
  /** The action of an action card or of a pace kind, in Chinese when it is a
   * common word (`actionWord`); any other word the AI used is shown as it is. */
  actionWords: {
    post: "发帖",
    comment: "评论",
    reply: "回复",
    delete: "删除",
    like: "点赞",
    upvote: "点赞",
    follow: "关注",
    message: "私信",
    dm: "私信",
    edit: "修改",
  } as Record<string, string>,
  reportCard: {
    header: (label: string) => `汇报 · ${label}`,
    older: (n: number) => `同一任务还有 ${n} 条更早汇报 ▸`,
    collapseOlder: "收起更早的汇报",
    hidden: "汇报卡已在设置里关闭",
    openLink: (link: string) => `打开 ${link}`,
    /** A long report text or posted text, folded to its first lines (fork, report line). */
    expand: "展开全文",
    collapse: "收起",
    /** An action report without the address of the item itself
     * (`evidence: "missing"`); also its run event mark in the timeline. */
    unconfirmed: "未确认：没有这条内容自己的链接",
    /** The other reason a report is not confirmed
     * (`evidenceWhy`; its run event mark too): the run did not look at it after acting. */
    unconfirmedWhy: {
      unverified: "未确认：没有亲眼确认",
      /** The item's own page was not read as words after
       * acting, or its words do not show what was posted. */
      unread: "未确认：没有读过这条内容自己的页面",
      gone: "未确认：这条内容自己的页面上没有它",
    },
    /** Under a confirmed action, the picture of the run's
     * look at what it did, labelled with when it looked (never the desktop's picture at report
     * time). */
    lookShot: (clock: string) => `亲眼确认时的画面 · ${clock}`,
  },
  /** Server report labels (fixed English) → what the card shows. See `reportLabel`. */
  reportLabels: {
    Plan: "计划",
    Update: "进展",
    Finished: "完成",
    "Needs attention": "出问题",
    "Needs your input": "等你回答",
    "Ready for your review": "等你审阅",
    "Change found": "网页有变化",
    "Run failed": "这轮失败",
    "Paused after repeated failures": "连续失败已暂停",
    "Watch needs attention": "监控出问题",
    /** An action report; the card adds the site and the action word as they are. */
    Action: "动作",
    // Report titles written before actions were reported per site.
    Comment: "评论",
    Post: "帖子",
    Reply: "回复",
    Message: "私信",
    Summary: "复盘",
    Notice: "提醒",
    // v0.6: the project's jobs (their cards read as their own words, jobs-core.ts noticeText).
    "Job declined": "没接活",
    "Job taken": "接了活",
    "Job done": "活做完了",
  } as Readonly<Record<string, string>>,
  /** Patterned server labels (see `reportLabel`). A wait is never a report (fork, report
   * line), so no wait label is here; its run event reads through `serverText`. */
  reportPatterns: {
    planVersion: (n: string) => `计划第 ${n} 版`,
    /** v0.6: a persona a task changed, one card per version. */
    personaVersion: (n: string) => `人设第 ${n} 版`,
    runFinished: (n: string) => `第 ${n} 轮完成`,
    overPace: " · 超出节奏",
    /** v0.6: an action on something another account of the project made, or on that account. */
    siblingTouched: " · 碰到自己人",
    /** v0.6: an action in a place another account of the project acted in too. */
    samePlace: (name: string) => ` · 和 ${name} 进了同一处`,
    /** 「评论 · example.com」: the action in Chinese when it is a common word (`actionWord`),
     * else as the AI wrote it; the site is data. */
    action: (action: string, site: string) => (site ? `${action} · ${site}` : action),
  },
  accountsPage: {
    title: "账号",
    newAccount: "新账号",
    byProject: "按群",
    unassigned: "未分配",
    /** Where the founder is (docs/founder.md): in the hall, for the whole space; never 未分配. */
    founderPlace: "Yuki · 创始人",
    noAccounts: "没有账号",
    /** The judgment card's one button: the account's detail has every action. */
    look: "去看看",
    /** The quiet line under the list (it is read once, refreshed by hand). */
    refreshHint: "打开时读一次",
    columns: {
      account: "账号",
      project: "群",
      desktop: "桌面",
      now: "此刻",
      pace: "节奏",
      /** Desktop only (design §3.6): the account's locale and time zone. */
      region: "地区",
      /** Web table: the light, the desktop and the account's flags. */
      state: "状态",
    },
    /** Web: the view tabs, the 列 ▾ menu (which columns show) and the 分组 ▾ menu. */
    views: { table: "表格", gallery: "画廊", board: "看板" },
    viewsLabel: "视图",
    columnsMenu: "列",
    groupMenu: "分组",
    noGroup: "不分组",
    details: "详情",
    assignTo: "分配到…",
    fetchedOnce: "打开这页时读一次；要看最新，点「刷新」。",
    /** A group heading with its account count: 「acmegame (1)」. */
    groupCount: (name: string, n: number) => `${name} (${n})`,
    unknownProject: "已删除的群",
    loading: "正在读取账号…",
    /** One project's accounts could not be read; the row data comes from the topology. */
    partial: (projects: string) => `${projects} 的账号详情暂时读不到，先显示概要。`,
    /** The 此刻 column of an account in another project (its tasks are read per project; phase 2
     * N4 brings them to this page). */
    nowOtherProject: "切到所在群才看得到",
  },
  /** Signing an account in (docs/account-login.md): what the AI recorded per site. */
  signIn: {
    /** One table with the server's (packages/domain credentials.ts): the chat's data reads the
     * same words the account row shows. */
    statuses: signInStatusWordsZh as Readonly<Record<string, string>>,
    /** One site on the account row: 「example.com 已登录」. */
    site: (site: string, status: string) => `${site} ${status}`,
    /** The row's 登录 line label. */
    label: "登录",
    /** Detail: 「用 alice 登录」, 「看 AI 记下的原话」. */
    asUser: (username: string) => `用 ${username} 登录`,
    detail: (text: string) => `AI 记下：${text}`,
    /** The page's own words the record quoted, found on the page. */
    seen: (text: string) => `页面上写着：${text}`,
    at: (clock: string) => `记于 ${clock}`,
    credentials: "凭据",
  },
  /** The card in the chat where the owner types what only he can
   * give; it goes to the credentials, never into the conversation. */
  guide: {
    /** The line above each card (`guideLead`): what now (the card to fill now) or 还有一件 (each
     * other card, drawn too: Fork), where to type it (the values never reach the
     * chat). */
    next: {
      site_login: (site: string) => `先给 ${site} 的登录`,
      verification_code: (site: string) => `先给 ${site} 的验证码`,
      also: (what: string) => `还有一件：${what}`,
      typed: "填在下面的卡片里，不会进对话，我也看不到。",
    },
    /** A card that is not the one to fill now, in its 「还有一件」 line. */
    later: {
      site_login: (site: string) => `${site} 的登录`,
      verification_code: (site: string) => `${site} 的验证码`,
    },
    skip: "先跳过",
    /** Above the input when the card to fill now has talk after it; it
     * scrolls back up to the card. */
    pointer: (n: number) => `还有 ${n} 件要你处理 ↑`,
    /** The card's heading: whose and what. */
    title: {
      site_login: (who: string, site: string) => `${who} · ${site} 的登录`,
      verification_code: (who: string, site: string) => `${who} · ${site} 的验证码`,
    },
    project: "本群",
    /** Why, when the card comes from an open need rather than the AI's own words. */
    why: {
      no_login: (site: string) =>
        `要在 ${site} 上做事，但还没存这个网站的登录。存下后我自己去登录。`,
      wrong_password: (site: string) => `${site} 说密码不对。换一个，我再去登录。`,
      needs_code: (site: string) =>
        `${site} 发了验证码（邮件或短信）。把码填在这里，我替你填进桌面上的输入框，再接着登录。`,
      needs_owner: (site: string) =>
        `${site} 有一步我自己试过了，过不去。弄好后回来点「我弄好了」，我接着干。`,
      unconfirmed: (site: string) =>
        `${site} 你说弄好了，我这边还没确认上登录。再看一眼桌面，弄好后再点一次「我弄好了」，或在对话里让我再看。`,
    },
    /** The one line that
     * says what the owner does on the desktop, by the status the AI recorded and never by the
     * site's own words: a check only a person can pass (a human or identity check), or a code the
     * site sent. Any other status is settled elsewhere and keeps its
     * words. */
    desktopStep: {
      needs_owner: "在桌面里完成验证",
      needs_code: "在桌面里输入验证码",
    } as Readonly<Record<string, string>>,
    site: "网站",
    username: "用户名",
    password: "密码",
    totpSeed: "两步验证密钥（可选，要密钥不要验证码）",
    cookies: "Cookie（可选，粘贴导出的 JSON）",
    more: "两步验证 / Cookie",
    code: "验证码",
    save: "保存",
    saving: "正在保存…",
    typeCode: "填进桌面",
    typing: "正在填入…",
    openDesktop: "打开桌面自己输",
    /** The card's main button: the kept page comes to the
     * front (or opens again) and the desktop is the owner's; then the desktop opens here. */
    goDesktop: "去桌面处理",
    goingDesktop: "正在带你过去…",
    /** What 去桌面处理 found, one line (the server's `state`). */
    /** After saving: only this, never what was typed. */
    saved: "已保存",
    typed: "已填入",
    withdrawn: "已不需要",
    savedLogin: "我这就去登录，结果会在这里告诉你。",
    typedLookAgain: "我去看一眼，接着登录。",
    desktopDone: "你在桌面里弄好了，我去看一眼，接着往下做。",
    /** What the chat gets after a card is saved (the owner's message; never a value). */
    savedNote: {
      site_login: (who: string, site: string) => `（已在卡片里保存 ${who} 的 ${site} 登录）`,
      verification_code: (who: string, site: string) =>
        `（已把 ${site} 的验证码填进 ${who} 桌面上的输入框）`,
    },
    /** The owner dealt with the code on the desktop himself (the chat's card). */
    desktopNote: (who: string, site: string) =>
      `（已在 ${who} 的桌面里自己处理了 ${site} 的验证码）`,
    /** A card posted with nothing typed. */
    empty: "先填一下再保存。",
    /** Why a code was not typed. */
    notTyped: {
      desktop_not_running: "这个号的桌面没在运行，打开桌面自己输，或等我把它打开。",
      browser_not_running: "桌面上的浏览器没开。",
      page_not_on_site: (site: string, page: string) =>
        `桌面上前台的页面是 ${page}，不是 ${site}，没有填。`,
      no_focused_field: "桌面上没有选中输入框，没有填。",
      field_not_found: "页面上找不到要填的输入框，没有填。",
      wrong_field_type: "桌面上选中的不是验证码输入框，没有填。",
      /** The page that asked for the code is gone from the browser. */
      page_gone:
        "要填验证码的那一页已经不在了，没有填。点「去桌面处理」，我重新打开登录页，可能要从头走一遍。",
      typing_uncertain: "可能已经填进去了，打开桌面看一眼。",
      length_mismatch: "填进去了，但输入框里的字数和要填的不一样，打开桌面看一眼。",
      other: (reason: string) => `没有填：${reason}`,
    },
    /** 需要你: open the card in the chat. */
    inChat: "在聊天里填",
    /** 需要你's item when the chat already shows the card for it (one line, not every site). */
    askedInChat: "已在聊天里问你",
  },
  /** The credentials page: every credential of the current project (docs/credentials.md). */
  credentials: {
    title: "凭据",
    loading: "正在读取凭据…",
    /** The page's one line, the one 添加 and the empty page. */
    introShort: "值保存后不再显示，只能更换或清除。",
    add: "添加",
    none: "还没有凭据。",
    gone: "这项凭据已经不在了，刷新看看。",
    groups: {
      pending: "待补",
      /** The project's own mailbox (发信、收询盘). */
      mailboxes: "发信邮箱",
      logins: "站点登录",
      project: "本群用",
    },
    empty: "没有。",
    request: (who: string, site: string) => `${who} 要 ${site} 的登录`,
    projectRequest: (site: string) => `本群要 ${site} 的登录`,
    /** A task needed to send an email and the project has no mailbox. */
    mailboxRequest: "本群要一个发信邮箱（任务要发邮件）",
    mailboxWhat: (address: string, reads: boolean) =>
      reads ? `${address} · 发信和收信` : `${address} · 只发信`,
    addForRequest: "去添加",
    loginWhat: (site: string, username: string | null) =>
      username ? `${site} · ${username}` : site,
    loginParts: (parts: string[]) => parts.join(" · "),
    partPassword: "密码",
    partTotp: "两步验证",
    partCookies: (n: number) => `Cookie ${n} 个`,
    usedBy: (names: string[]) => `用在：${names.join("、")}`,
    usedNowhere: "没用在任何地方",
    usedProject: "本群默认桌面",
    /** A mailbox serves the project (its tasks send from it), not a desktop. */
    usedProjectMailbox: "本群",
    unknownAccount: "已不在本群的账号",
    lastOk: (status: string) => `上次：${status}`,
    lastFail: (status: string, detail: string | null) =>
      detail ? `上次：${status}（${detail}）` : `上次：${status}`,
    neverResult: "还没有结果",
    lastUsed: (clock: string) => `上次使用 ${clock}`,
    neverUsed: "还没用过",
    added: (clock: string) => `添加于 ${clock}`,
    replaced: (clock: string) => `更换于 ${clock}`,
    unreadable: "已保存，但用当前的凭据密钥读不出：请更换或清除",
    replace: "更换",
    clear: "清除",
    history: "记录",
    allHistory: "全部记录",
    addMailbox: "添加发信邮箱",
    addLogin: "添加站点登录",
    clearConfirm: "清除后这条凭据就没了，用它的账号要换一条。确定清除？",
    cleared: "已清除",
    saved: "凭据已保存",
    added_toast: "凭据已添加",
    /** 保存 with nothing changed: the editor closes and says so (never silently). */
    unchanged: "没有改动，凭据保持原样",
    /** Result codes of the last use, in words. */
    results: {
      ok: "可用",
      signed_in: "已登录",
      wrong_password: "密码不对",
      needs_code: "要验证码",
      suspended: "号被封",
      blocked: "被网站拦下",
      no_login: "缺登录",
      needs_owner: "要你接手",
      other: "其他情况",
      failed: "没成功",
      not_typed: "没打进去",
      typing_uncertain: "可能已打进去，没确认",
      helper_failed: "浏览器助手没给出结果",
      helper_timed_out: "浏览器助手超时",
      browser_not_running: "浏览器没开",
      no_page: "浏览器里没有页面",
      no_focused_page: "没有页面在前台",
      websocket_missing: "桌面缺少浏览器助手的组件",
      devtools_not_browser: "接管浏览器调试端口的不是桌面浏览器，已拒绝",
      focus_changed: "焦点已移开，没有打入",
      no_focused_field: "没有选中输入框，没有打入",
      length_mismatch: "打进去了，但输入框里的字数和保存的不一样",
      page_not_on_site: "前台页面不是这个网站，没有打入",
      field_not_found: "页面上找不到要填的输入框",
      insert_failed: "浏览器没接受输入",
      bad_file: "Cookie 文件读不了",
      /** Saving a sign-in's cookies (get-cookies). */
      read_failed: "浏览器的 Cookie 读不出来",
      no_cookies: "浏览器里没有这个网站的 Cookie",
      usage: "浏览器助手调用有误",
      /** A stranger's view read in the desktop's browser (stranger-read). */
      no_private_context: "浏览器开不了无痕窗口",
      load_failed: "页面没打开",
      unreadable: "凭据读不出",
      field_not_saved: "这一项没存",
      no_saved_login: "没有存这个登录",
    } as Readonly<Record<string, string>>,
    editor: {
      newLogin: "新站点登录",
      newMailbox: "新发信邮箱",
      mailboxAddress: "邮箱地址",
      mailboxAddressPlaceholder: "名字@公司域名",
      mailboxPassword: "密码或授权码",
      mailboxPasswordHint: "多数邮箱要用「授权码」：在邮箱网页版的设置里开启 SMTP/IMAP 后生成",
      smtpHost: "发信服务器（SMTP）",
      smtpHostPlaceholder: "smtp.公司域名",
      smtpPort: "SMTP 端口",
      smtpPortHint: "465 走 SSL；587 走 STARTTLS",
      imapHost: "收信服务器（IMAP，可选）",
      imapHostPlaceholder: "imap.公司域名",
      imapHostHint: "填了才能读收件箱里的询盘和回复；不填就只发信",
      imapPort: "IMAP 端口",
      mailboxHint:
        "保存后，任务发的邮件都从这个邮箱发出；每封发出前都会先进「等你审阅」，你看过才发。",
      mailboxNeedsAddress: "要填邮箱地址。",
      mailboxNeedsSmtp: "要填发信服务器（SMTP）。",
      mailboxNeedsPassword: "要填密码或授权码。",
      replaceTitle: (name: string) => `更换 ${name}`,
      label: "名称（可选）",
      usedBy: "用在",
      usedByProject: "本群默认桌面",
      usedByNone: "暂不使用",
      savedPart: "已保存",
      keep: "留空 = 不改",
      save: "保存",
      saving: "正在保存…",
      clearPart: "清除这一项",
      /** The two-factor key goes with the password, so clearing one clears both. */
      clearPasswordWithTotp: "清除密码（连同两步验证密钥）",
    },
    log: {
      title: (name: string) => `记录 · ${name}`,
      allTitle: "凭据记录",
      empty: "还没有记录。",
      more: "更早的记录",
      loading: "正在读取记录…",
      line: (clock: string, what: string, who: string, outcome: string) =>
        `${clock} · ${what} · ${who}${outcome ? ` · ${outcome}` : ""}`,
      events: {
        added: "添加",
        replaced: "更换",
        cleared: "清除",
        removed: "删除",
        linked: "用到",
        unlinked: "不再用于",
        used: "使用",
        result: "结果",
        moved_in: "移入",
        moved_out: "移出",
        copied_in: "复制进来",
        migrated: "迁移",
      } as Readonly<Record<string, string>>,
      parts: {
        username: "用户名",
        password: "密码",
        totp_code: "两步验证码",
        totp_seed: "两步验证密钥",
        cookies: "Cookie",
        mailbox_password: "邮箱密码",
      } as Readonly<Record<string, string>>,
      purposes: {
        fill: "填入",
        cookie_import: "导入 Cookie",
        /** A proven sign-in's cookies, saved by the server. */
        cookie_export: "登录成功后保存 Cookie",
        mail_send: "发信",
        mail_read: "收信",
      } as Readonly<Record<string, string>>,
      owner: "你",
      task: (title: string | null) => (title ? `任务「${title}」` : "任务"),
      chat: "对话",
      system: "系统",
      ok: "成功",
      failed: (reason: string) => `没成功（${reason}）`,
      account: (name: string) => `账号 ${name}`,
    },
  },
  /** v1.5: a member's files on her card (docs/member-files.md). */
  memberFiles: {
    duties: "职责",
    memory: "记住的事",
    notes: "笔记",
    open: "打开",
    save: "保存",
    cancel: "取消",
    saving: "保存中…",
    empty: "还没有内容。",
    noNotes: "最近 7 天没有笔记。",
    notesHint: "她每完成一轮任务或例行，会自动记一行。",
    loadFailed: "文件还没读到",
    saveFailed: "没有保存成功，再试一次",
    tooLong: "文件太大了，最多 64 KB",
    changed: (line: string) => (line ? `最后修改 ${line}` : ""),
    editorTitle: (name: string, path: string) => `${name} · ${path}`,
    pathNames: {
      "AGENTS.md": "职责与做法",
      "MEMORY.md": "长期记忆",
    } as Record<string, string>,
    hint: "这是一个 Markdown 文件。她每次干活前都会先读它。",
  },
  accountDetail: {
    shotEmpty: "桌面还没创建。启动后这里显示最近一次操作的截图。",
    shotStopped: "桌面已暂停，启动后显示最近一次操作的截图。",
    desktop: "桌面",
    project: "群",
    region: "地区",
    pace: "节奏",
    label: "标签",
    openDesktop: "打开桌面",
    /** 看看 pins the desktop beside the timeline (wide) or opens the desktop
     * sheet (narrow); 收起桌面 unpins it. */
    look: "看看",
    unpin: "收起桌面",
    pinnedClose: "收起",
    start: "启动",
    stop: "暂停",
    starting: "正在启动…",
    stopping: "正在暂停…",
    started: "桌面已启动",
    stopped: "桌面已暂停，登录和文件保留",
    moveTo: "移到…",
    assignTo: "分配到…",
    tasks: "这个号上的任务",
    noTasks: "没有任务。",
    reports: "最近汇报（这个号）",
    noReports: "还没有汇报。",
    dispatch: "在聊天里派活…",
    /** An account of another project: the button switches there, then fills its chat. */
    dispatchIn: (project: string) => `切到「${project}」在聊天里派活…`,
    unassign: "退回未分配",
    edit: "编辑",
    remove: "删除",
    removeWarning: "删除会销毁这个账号的桌面、浏览器配置和上面所有的登录。",
    removeConfirm: (name: string) => `输入「${name}」确认删除`,
    removeButton: "删除账号",
    /** The member's profile card (web): the same confirmed delete, in a member's words. */
    removeMember: "删除成员",
    removed: "账号已删除",
    gone: "这个账号已经不在了。",
    /** Caption under the latest screenshot; the server does not say when it was taken. */
    shotLatest: "最近一次操作的截图",
    shotNone: "还没有截图。任务操作过桌面后，这里显示最近一次的画面。",
    shotError: "桌面出错，暂时看不到截图。",
    shotLoading: "正在读取截图…",
    shotAlt: "桌面最近一次操作的截图",
    localeUnreadable: "时区和语言读不出，在账号里重填",
    notSet: "没设",
    /** The detail's 地区 line (`regionLine`): neither set, or which one is missing. */
    regionUnset: "还没设（时区和语言用桌面默认的）",
    localeUnset: "语言没设",
    timezoneUnset: "时区没设",
    /** The account belongs to another project: its tasks and reports live there. */
    otherProject: (project: string) =>
      `这个号在「${project}」。它的任务和汇报要切到那个群才看得到。`,
    switchTo: (project: string) => `切到 ${project}`,
    /** The account has no zone of its own: which zone 「当地」 is (the desktop template's). */
    pacingZoneTemplate: (zone: string) => `账号没设时区，「当地」按桌面模板的 ${zone}`,
    pacingZoneUnreadable: (zone: string) => `账号时区读不出，「当地」按桌面模板的 ${zone}`,
    /** Joins the settings line and the 额度 hint. */
    pacingJoin: "；",
    removing: "正在删除…",
    loadingAccount: "正在读取账号…",
    reportOpen: "打开链接",
  },
  assign: {
    moveTitle: (name: string) => `把 ${name} 移到…`,
    assignTitle: (name: string) => `把 ${name} 分到…`,
    tasksWarning: (n: number, titles: string) =>
      `这个号上还有 ${n} 个任务（${titles}）。移走后这些任务找不到账号。`,
    accounts: (n: number) => `${n} 号`,
    unassign: "退回未分配",
    /** Shown only when moving an account that is already in a project (assigning is one step). */
    twoSteps:
      "跨群移动分两步：先退回未分配，再分到目标群。第二步失败时账号停在未分配，可以再试，不丢数据。",
    movedBoth: (project: string) => `两步完成：先退回未分配，再分到 ${project}`,
    assigned: (project: string) => `已分到 ${project}`,
    unassigned: "已退回未分配",
    stuck: "账号停在未分配：第二步没成功。",
    retry: "再试",
    moving: "正在移动…",
  },
  join: {
    title: "加入未分配账号",
    add: "加入",
    empty: "没有未分配账号。去「账号」新建。",
    joined: (project: string) => `已加入 ${project}`,
    loading: "正在读取未分配账号…",
    joining: "正在加入…",
  },
  accountEditor: {
    newTitle: "新账号",
    editTitle: (name: string) => `编辑 ${name}`,
    hint: "新账号先放在未分配。",
    /** Site logins (docs/account-login.md). */
    loginsTitle: "站点登录",
    loginsHint: "保存后系统会自己在这个号的桌面里登录这些站点。值保存后不再显示。",
    loginRow: (site: string, username: string) => `${site} · ${username}`,
    loginNoUser: "（没填用户名）",
    loginPassword: (saved: boolean) => (saved ? "密码 已保存" : "密码 未填"),
    loginTotp: (saved: boolean) => (saved ? "两步验证 已保存" : "两步验证 未填"),
    loginCookies: (saved: boolean) => (saved ? "Cookie 已保存" : "Cookie 未填"),
    loginReplace: "更换",
    loginRemove: "删除",
    loginAdd: "添加站点登录",
    loginSite: "站点",
    loginSitePlaceholder: "例如 example.com 或登录页网址",
    loginUsername: "用户名",
    loginPasswordInput: "密码",
    loginTotpInput: "两步验证密钥（可选，要密钥不要验证码）",
    loginTotpHint: "开两步验证时显示的那串字母数字，或 otpauth:// 链接。",
    loginCookiesInput: "Cookie（可选，粘贴导出的 JSON）",
    loginKeep: "留空 = 不改。",
    loginPending: "保存后加入",
    loginAddDone: "加到列表",
    /** Sign-in fields: what a login lacks, said before the request. */
    gapPasswordNeedsUser: "填了密码就要填用户名",
    gapTotpNeedsPassword: "两步验证密钥要和密码一起",
    gapNeedsSecret: "新登录要有密码或 Cookie",
    gapSiteRequired: "站点必填",
    gapSiteTwice: "同一个站点只能有一条登录",
    name: "名称",
    namePlaceholder: "例如 acct-2",
    label: "标签（只是备注）",
    labelPlaceholder: "例如 主号",
    timezone: "时区",
    locale: "语言",
    clear: "清除",
    unreadable: "保存的时区和语言用服务器当前的密钥读不出，请重新填写这两项。",
    nameRequired: "名称必填",
    created: "账号已建好，放在未分配",
    saved: "已保存",
    loading: "正在读取账号设置…",
    notSaved: "没保存",
    secretUnreadable: "已保存，但读不出",
    clearAll: "全部清除",
    cleared: "已清除",
    timezonePlaceholder: "America/Los_Angeles",
    localePlaceholder: "en-US",
    savedAs: (value: string) => `保存为 ${value}`,
    pick: "常用",
    nameTooLong: (max: number) => `名称最多 ${max} 个字`,
    nameReserved: (name: string) => `「${name}」留给群默认桌面，换一个名称`,
    labelTooLong: (max: number) => `账号标签最多 ${max} 个字`,
    unknownTimezone: (value: string) =>
      `不认识的时区「${value}」，请用 America/Los_Angeles 这样的写法`,
    unknownLocale: (value: string) => `不认识的语言「${value}」，请用 en-US 这样的写法`,
    applyNextStart: "时区、语言的改动在桌面下次启动时生效。",
    create: "建账号",
    gone: "这个账号已经不在了，刷新列表看看。",
    hoursSeparator: "–",
  },
  /** An account's desktop sheet (computer.tsx, computer-workspace.tsx, desktop-stream.tsx). */
  computer: {
    tabs: { Browser: "浏览器", Desktop: "桌面", Terminal: "终端", Files: "文件" },
    workspace: "Linux 桌面",
    running: "运行中 · 暂停后文件保留",
    stopped: "已暂停 · 文件已保存",
    unconfigured: "服务器还没配置桌面",
    attention: "连接出了问题",
    connecting: "正在连接…",
    stop: "暂停桌面",
    start: "启动桌面",
    refresh: "刷新",
    // Drop this desktop so the next start makes a new one from the
    // current template; the two-step confirmation in the panel.
    rebuild: "重建桌面",
    rebuildConfirm:
      "重建会销毁这台桌面：上面的浏览器资料和所有网站登录都会没掉。账号本身、它的时区和语言设置，以及服务器里保存的文件都还在。下次点「启动桌面」会按当前模板生成一台新桌面，网站要重新登录。",
    rebuildNow: "确认重建",
    notCreated: "还没创建 · 启动后按当前模板生成一台新桌面",
    retryConnection: "重新连接",
    terminal: "终端",
    cwd: "工作目录",
    command: "命令",
    straightQuotes: "换成直引号",
    runCommand: "运行命令",
    networkOn: "在这台桌面上运行，可以上网。图形程序用 >/dev/null 2>&1 & 启动，到「桌面」页去看。",
    networkOff: "在这台桌面上运行，不能上网。",
    newCommand: "新命令",
    commandRunning: "正在运行… 结果会出现在这里。暂停桌面会结束正在运行的命令。",
    firstCommandTitle: "还没有运行过命令",
    firstCommandDetail: "可以运行脚本、处理文件；任务也会在这里留下它运行的命令。",
    showRecent: "只看最近的命令",
    showEarlier: "更早的命令",
    desktopOff: "桌面没在运行",
    desktopOffDetail: "启动后可以在这里看到并操作桌面。",
    desktopShared:
      "你和任务共用这台桌面。暂停会关掉桌面上的程序，/workspace 里的文件保留。打开桌面会让它保持 30 分钟不休眠；保持这个页面打开或回到应用可以延长。这个链接能操作桌面，不要分享。",
    commandStatus: {
      running: "运行中",
      succeeded: "成功",
      failed: "失败",
      timed_out: "超时",
      interrupted: "被中断",
    } as Readonly<Record<string, string>>,
    exitCode: (code: number) => ` · 退出码 ${code}`,
    noOutput: "没有输出",
    outputTruncated: "输出超过了显示上限，大的结果请写进文件。",
    hideOutput: "收起输出",
    showOutput: "展开输出",
    openDesktop: "打开桌面",
    opening: "正在打开…",
    desktopFrame: "桌面画面",
    refreshComputer: "刷新桌面",
    // The default desktop's Browser and Files tabs (设置 → 高级).
    browserConnected: "浏览器已连接",
    browserOffline: "浏览器未连接",
    browserConnectedHint: "任务用的浏览器和文件都在这里。",
    browserOfflineHint: "启动浏览器服务后才能连接。",
    address: "网址",
    openBrowser: "打开浏览会话",
    noBrowsers: "在这里打开一个网页，或让任务去查资料；它的浏览会话会出现在这里。",
    browsersHint: "浏览会话各自保留登录和下载。打开一个可以接管，看完回到对话。",
    browser: "浏览器",
    sessionSaved: "会话已保存",
    sessionAttention: "需要处理",
    previewUnavailable: "预览看不到，打开浏览器重新连接。",
    reopenBrowser: "重新打开浏览器",
    reconnectBrowser: "重新连接浏览器",
    takeControl: "接管",
    preview: (title: string) => `浏览器预览：${title}`,
    documents: "文件",
    documentsHint: "邮件里存下的 PDF、浏览器下载和你上传的文件。",
    pdfPages: (n: number) => `${n} 页 · PDF`,
    importDocument: "导入文件",
    // Files tab (default desktop).
    files: "桌面上的文件",
    filesOff: "启动桌面后才能浏览或编辑文件。",
    filePath: "文件路径",
    fileContents: "文件内容",
    saveFile: "保存文件",
    discard: "放弃修改",
    backToFiles: "回到文件列表",
    up: "上一级",
    newFile: "新文件",
    newFolder: "新文件夹",
    refreshFiles: "刷新文件",
    hideDocuments: "收起文件",
    copyDocument: "把文件复制到这里",
    choosePdf: "选一个已存的 PDF",
    copyHint: "复制到这个文件夹；同名文件会被替换。",
    noDocuments: "还没有可复制的文件。",
    folderName: "文件夹名",
    createFolder: "建文件夹",
    cancel: "算了",
    folder: "文件夹",
    symlink: "符号链接",
    kb: (n: number) => `${n} KB`,
    emptyTitle: "这里还是空的",
    emptyDetail: "在这里新建一个文件，或让任务在桌面上生成。",
    copied: "文件已复制到桌面。",
    saved: "文件已保存到桌面。",
    accountTitle: (name: string) => `${name} 的桌面`,
    /** The desktop at work, small beside the timeline; a click shows it large. */
    previewTitle: (name: string) => `${name} 在用桌面`,
    previewOpen: "点开放大",
    accountSubtitle: (label: string | null) =>
      `这个账号自己的桌面${label ? `（${label}）` : ""}。需要时可以接管。`,
  },
  /** The fold markers of 计划 / 任务规则 / 时间线. */
  fold: {
    closed: "▸",
    open: "▾",
  },
  taskDetail: {
    account: "账号",
    rhythm: "节奏",
    /** 「一次性」, 「每天 · 已跑 4 轮」: no count of waits or continuations (fork, report line:
     * neither has a limit, and a counter is nothing the person acts on). */
    rhythmLine: (rhythm: string, runs: string) => [rhythm, runs].filter(Boolean).join(" · "),
    defaultDesktop: "默认桌面",
    viewDesktop: "看桌面",
    nowDoing: "现在在做",
    /** A run while the worker has no heartbeat: the step it stopped on (nothing is being done). */
    stoppedTitle: "停在这一步",
    /** A task in its own wait: when it goes on (fork, report line: the AI's wait note is its
     * handoff to its next run, never the person's text). */
    waitTitle: "等待",
    schedule: "排期",
    scheduleLine: (rhythm: string, next: string) => `${rhythm}跑一次。下次 ${next}。`,
    pausedTitle: "已暂停",
    pausedInWait: (clock: string) => `原定 ${clock} 恢复。点「恢复」后照原计划继续。`,
    pausedPlain: "点「恢复」后继续。",
    error: "错误",
    question: "等你回答",
    review: "等你审阅",
    reviewMissing: "这项审阅还没准备好，刷新后再试。",
    result: "结果",
    reports: (n: number) => `本任务汇报 (${n})`,
    noReports: "还没有汇报。",
    plan: (done: number, total: number) => `计划 ${done}/${total}`,
    /** An operating task's plan (bound to an account): its steps say nothing about where it is,
     * so no count and no 「← 当前」 (fork, report line). */
    planPlain: "计划",
    rules: "任务规则",
    /** A task the chat delegated: the chat drafted these rules from what you said. */
    rulesHint:
      "聊天代拟：聊天按你说的话写的，任务每轮都遵守。要改，在聊天里说一句（如「别发帖，只回复」）。",
    /** A task from the 新任务 form: the rules are what the person typed there. */
    rulesHintTyped: "你写的：在「新任务」里写下的规则，任务每轮都遵守。",
    timeline: "时间线",
    noTimeline: "后台每做一步都会记在这里。",
    menu: "更多：改间隔、停止重复、取消任务",
    changeInterval: "改间隔",
    intervalLabel: "每隔多少分钟跑一次",
    intervalSave: "保存间隔",
    repeatThis: "改成重复",
    stopRepeating: "停止重复",
    cancelTask: "取消任务",
    cancelConfirm: "确认取消这个任务？取消后不能恢复。",
    /** v0.6: Cancel on an account's standing loop is 停止经营. */
    stopOperating: "停止经营",
    stopOperatingConfirm: "停止经营：清空这个号的长期目标，派给它的活这个号不做了（别的号照常）。",
    cancelYes: "取消任务",
    cancelNo: "算了",
    cancelled: "任务已取消",
    loading: "正在读取任务…",
    gone: "这个任务已经不在了。",
    stepDone: " ✓",
    stepCurrent: " ← 当前",
    /** 排期 block of a one-off task scheduled for later. */
    scheduleOnce: (next: string) => `下次 ${next} 运行。`,
    /** The bound account is no longer in this project. */
    accountGone: "绑定的账号已不在本群",
    /** Toast after 改间隔 / 改成重复 saved: 「已改为每 30 分钟」. */
    intervalSaved: (rhythm: string) => `已改为${rhythm}`,
    /** Toast after 停止重复. */
    repeatStopped: "已停止重复",
    /** 运营计划 · 选区: one community per line. */
    community: (name: string, why: string, rule: string) => {
      const tail = [why, rule].filter(Boolean).join(" · ");
      return tail ? `${name} — ${tail}` : name;
    },
    /** 时间线: older events not shown. */
    olderEvents: (n: number) => `还有 ${n} 条更早的记录`,
    /** 本任务汇报 could not be read; the rail's copy is shown instead. */
    reportsPartial: "只显示了最近的汇报，完整列表暂时读不到。",
  },
  /** The 每 [n] 分钟 field (new-task form, 改间隔): parseRepeatMinutes' refusals. */
  interval: {
    required: "填每隔多少分钟跑一次，1 到 10080（7 天）。",
    whole: "填整数分钟。",
    tooSmall: "至少每 1 分钟跑一次。",
    tooLarge: "最多每 10080 分钟（7 天）跑一次。",
  },
  /** The older repeat editor (task-schedule.tsx): the account a task runs on and its interval.
   * Run now / 改间隔 / 停止重复 are `tasksRail`'s; the field label is `newTask.intervalLabel`. */
  taskSchedule: {
    runOnce: "留空就只跑一次",
    runOn: "在哪里跑",
    loadingAccounts: "正在读取本群的账号…",
    usesAccount: "任务用这个号的桌面和登录。",
    noAccounts: "本群还没有账号，任务跑在默认桌面上。",
    runsOn: "跑在：",
    accountGone: "一个已不在本群的账号",
    boundAccount: "绑定的账号",
    repeatThis: "设为重复",
    example: "例如 30",
    saveInterval: "保存间隔",
  },
  operatingPlan: {
    title: (version: number) => `运营计划第 ${version} 版`,
    communities: "选区",
    forms: "内容形式",
    voice: "口径",
    pace: "节奏",
    review: "复盘",
    horizon: "期限",
    setAt: (clock: string) => `拟定于 ${clock}`,
  },
  newTask: {
    title: "新后台任务",
    hint: "大多数时候直接在聊天里说就行。这里用于要准确指定账号和重复周期的时候。节奏、口径、汇报由任务自己按这个号的情况定，不在这里填。",
    what: "要做什么",
    whatPlaceholder: "例如：看看今天有没有人在讨论 ……",
    whatRequired: "写一句要做什么。",
    account: "在哪个账号上跑（必选）",
    accountHint: "只列本群账号。",
    noAccounts: "本群还没有账号，先加入一个。",
    repeat: "重复",
    once: "只跑一次",
    every: "每",
    minutes: "分钟",
    intervalLabel: "间隔分钟",
    submit: "交给后台",
    submitted: "已交给后台，排队中",
    /** createTaskSchema caps the prompt at 12000 characters. */
    tooLong: (max: number) => `太长了，最多 ${max} 字。`,
    /** One option of 在哪个账号上跑: 「Oak_Example_2（桌面 运行中）」. */
    accountOption: (name: string, desktop: string) => `${name}（${desktop}）`,
    /** Accessible name of the account picker. */
    pickAccount: (current: string) => `选择账号，当前 ${current}`,
    accountRequired: "选一个账号。",
  },
  settings: {
    /** The pro view switch (internal spaces only). */
    proView: "专业视图",
    proViewHint: "电脑上显示项目栏和实况栏（带计数），账号页、凭据页用详细版；只影响这台设备",
    proViewOn: "开",
    proViewOff: "关",
    title: "设置",
    /** The panes (v1.5, R9): the list on the left, or above on a narrow screen. */
    panes: { general: "通用", computer: "电脑", apps: "应用", skills: "技能" },
    paneNav: "设置栏目",
    /** 外观. */
    appearance: "外观",
    appearanceHint: "只影响这个浏览器。",
    appearanceChoice: { system: "跟随系统", light: "浅色", dark: "深色" },
    /** 时区: one for the account, used by routines' clock times. */
    timeZone: "时区",
    timeZoneHint: "例行的钟点按这个时区算。",
    timeZoneUnset: (zone: string) => `还没设，先按这个浏览器的 ${zone}`,
    timeZoneSave: "保存",
    timeZoneSaved: "时区已保存。",
    timeZoneBad: "请填一个有效的时区，例如 Asia/Shanghai。",
    timeZoneFailed: (why: string) => `时区没保存上：${why}`,
    timeZoneLoading: "读取中…",
    /** The clock line of a routine: which zone its clock time is read in. */
    clockZone: (zone: string) => `按 ${zone}`,
    /** 动作审查 and its two lists of sentences. */
    actionReview: "动作审查",
    actionReviewHint:
      "开启后，每个动作出卡片前先由另一次模型判断：命中「先问我」就问你，命中「自动放行」或判断为低风险就直接执行；发给别人的消息（邮件）只有命中「自动放行」才会直接发。审查出错时一律先问你。",
    askFirstTitle: "先问我",
    autoAllowTitle: "自动放行",
    ruleListCount: (n: number, max: number) => `${n}/${max}`,
    ruleListFull: (max: number) => `最多 ${max} 条`,
    ruleListEmpty: "还没有",
    ruleAdd: "添加",
    ruleEdit: "改",
    ruleDelete: "删",
    ruleSave: "保存",
    ruleCancel: "取消",
    rulePlaceholder: "用一句话写，例如：给客户发报价邮件",
    reviewSettingsFailed: (why: string) => `动作审查设置没保存上：${why}`,
    /** The signed-in user (a member, maybe not an admin). */
    admin: "账号",
    changePassword: "改密码",
    signOut: "退出",
    currentPassword: "当前密码",
    newPassword: "新密码",
    newPasswordHint: "至少 8 位",
    repeatPassword: "再输一次新密码",
    savePassword: "保存密码",
    passwordsDiffer: "两次输入的新密码不一样。",
    passwordMissing: "请输入当前密码。",
    passwordChanged: "密码已修改，其他会话已退出。",
    /** The Google connection (Gmail and Calendar), shared by every project. */
    google: "谷歌",
    googleConnected: (account: string) => `已连接 ${account}`,
    googleNone: "没连接。发邮件也可以用群凭据里的发信邮箱。",
    googleConnect: "连接",
    googleReconnect: "重新连接",
    googleDisconnect: "断开",
    googleOpened: "已在浏览器打开 Google 授权页，授权完回来刷新。",
    googleDisconnected: "已断开 Google。",
    googleFailed: (detail: string) => `没连上：${detail}`,
    reports: "汇报",
    reportsInChat: "汇报卡显示在聊天里",
    reportsOn: "开",
    reportsOff: "关",
    worker: "后台",
    workerOk: (clock: string) => `正常 · 最后心跳 ${clock}`,
    workerDown: (minutes: string, clock: string) => `已停 ${minutes} · 最后心跳 ${clock}`,
    workerUnknown: "还没有心跳",
    advanced: "高级",
    defaultDesktop: "群默认桌面",
    defaultDesktopHint: "不属于任何账号；没绑账号的任务跑在这里，也用于排错。",
    openDefaultDesktop: "打开默认桌面",
    /** Shown when the session has no username (the server's default admin). */
    adminFallback: "admin",
    passwordTooShort: (min: number) => `新密码至少 ${min} 位。`,
    passwordWrong: "当前密码不对。",
    passwordTooMany: "试得太多了，过一会儿再试。",
    passwordFailed: (detail: string) => `密码没改成：${detail}`,
    reportsSaveFailed: (detail: string) => `没能保存：${detail}`,
    /** The app's version line (shell/version.ts versionLabel). */
    version: "版本",
    /** v1.4 (docs/apps.md): connected apps, shared by the whole space. */
    apps: {
      title: "连接的应用",
      hint: "连一次，全空间的成员和群都能用。",
      states: {
        connected: "已连接",
        not_connected: "没连接",
        not_configured: "服务器没配置",
      } as Readonly<Record<string, string>>,
      preset: "预设",
      custom: "自定义",
      connect: "连接",
      reconnect: "重新连接",
      disconnect: "断开",
      mailboxHint: "在本群的凭据里添加",
      googleHint: "用上面「谷歌」一行连接或断开",
      tools: (n: number) => `${n} 个工具`,
      opened: "已在浏览器打开授权页，授权完回来刷新。",
      connected: (name: string) => `已连接 ${name}。`,
      disconnected: (name: string) => `已断开 ${name}。`,
      confirmDisconnect: (name: string) => `断开「${name}」？它的令牌会一并删除。`,
      failed: (detail: string) => `没成功：${detail}`,
      tokenField: "访问令牌",
      tokenHint: "需要时再填；填了就不走自动授权",
      addTitle: "添加自定义 MCP 服务",
      name: "名字",
      url: "地址",
      urlHint: "https://…/mcp",
      add: "添加",
      adding: "连接中…",
    },
    /** v1.4 (docs/skills.md): the space's skills. */
    skills: {
      title: "技能",
      none: "还没有技能。在聊天里说「把……存成技能」，或做完一件事后说「把刚才的学成技能」。",
      count: (n: number) => `${n} 个，全空间共用`,
      open: "打开",
      name: "名字",
      description: "用途",
      descriptionHint: "写清什么时候用它，比如「每周要汇总……时用」",
      missingPurpose: "缺用途说明",
      steps: "步骤",
      save: "保存",
      remove: "删除",
      confirmRemove: (name: string) => `删除技能「${name}」？`,
      sourceSentence: "一句话存的",
      sourceDemo: "从对话学的",
      failed: (detail: string) => `技能没能保存：${detail}`,
    },
  },
  /**
   * Fixed English the server (or the browser) sends and the UI shows: task timeline lines, the
   * default plan steps, sign-in and validation errors, network failures. See `serverText`.
   * Text the model wrote (step notes, results) is never translated.
   */
  server: {
    /** A whole line equal to one of these. */
    lines: {
      // The question a task stopped on before the report line when a run ended without a
      // completion call (runEndedWithoutCompletionQuestion), as a past card shows it. Such a
      // run now simply continues.
      "The agent reached the end of this run without confirming completion. Give it a follow-up instruction to continue.":
        "上一轮结束时还没确认做完。点「立即继续」让它接着做，或告诉它下一步。",
      // Sign-in and setup (apps/server/src/auth.ts, session-core.ts).
      "Username or password is incorrect": "用户名或密码不对。",
      "An account already exists. Sign in instead.": "已经有账号了，请直接登录。",
      "Setup code is incorrect. It is printed in the server log.":
        "设置码不对，它印在服务器日志里。",
      "Too many sign-in attempts. Try again in a minute.": "登录尝试太多，一分钟后再试。",
      "Too many requests. Try again in a minute.": "刚才的请求太多了，过一分钟再试。",
      "No account yet. Finish setup first.": "还没有账号，先完成设置。",
      "Session expired. Sign in again.": "登录已过期，请重新登录。",
      // Spaces, members and invite links (tenancy/server/tenancy/service.ts).
      "Space not found": "空间不存在",
      "Project not found": "群不存在",
      "Choose a space": "先选一个空间",
      "You are not a member of any space": "你还不在任何空间里。找空间的管理员要一个邀请链接。",
      "Only an admin of this space can do this": "只有这个空间的管理员能做这件事",
      "A space needs at least one admin": "空间至少要有一位管理员",
      "This invite link can no longer be used. Ask an admin for a new one.":
        "这个邀请链接已经不能用了，请找管理员要新的。",
      "This username is taken. Choose another one.": "这个用户名已经有人用了，换一个。",
      "Choose a username and a password": "请设一个用户名和密码。",
      "Member not found": "找不到这位成员",
      "Invite not found": "找不到这个邀请链接",
      "This space already has members; its admins invite people":
        "这个空间已经有成员了，由它的管理员邀请人",
      "The sample workspace has no other members": "示例工作台没有其他成员",
      "Sign in with your username and password": "请用用户名和密码登录。",
      "Sign in to OpenMuse": "请先登录。",
      "Current password is incorrect": "当前密码不对。",
      "The password changed meanwhile. Sign in again.": "密码刚被改过，请重新登录。",
      "Username must be 1 to 32 characters: letters, digits, dot, dash or underscore":
        "用户名：1 到 32 个字符，只能用字母、数字、点、短横线或下划线。",
      "Could not reach the server.": "连不上服务器。",
      "Could not sign in.": "没能登录。",
      "Could not finish setup.": "没能完成设置。",
      "Could not change the password.": "密码没改成。",
      // A save that would start a sign-in task with the task list full.
      "Finish or cancel some tasks before adding more":
        "未结束的任务太多，先结束或取消一些再添加。",
      "site must be a website's address or domain": "站点要填网站的地址或域名。",
      // Task timeline (apps/server/src/engine/service.ts).
      "Changed by you": "你改的",
      "Run requested": "已要求立即运行",
      "Repeating stopped": "已停止重复",
      "Agent update": "进展",
      "Work completed": "完成",
      "Task needs attention": "出问题",
      "Started working": "开始工作",
      "Resumed work": "继续工作",
      "Approved action completed": "审阅通过的操作已完成",
      // A review sent without the owner's decision, and which way it
      // went out (service.ts executeOnce): the status event's title.
      "Sent: nobody declined": "6 小时内没人拒绝，已发出",
      "Sent by your rule": "按你定的规则，已发出",
      // The body of the "Ready for your review" outcome (service.ts
      // publishOutcome): the report card's words while a prepared action waits for the owner.
      "A prepared action is waiting for your review. Open the task to approve or decline it.":
        "有一个准备好的动作在等你审阅，打开任务就能同意或拒绝。",
      "Task interrupted": "任务被打断",
      // Run events of the other task kinds (service.ts).
      "Found the document": "找到了文件",
      "Saved a filled copy": "存了一份填好的副本",
      "Analyzing the imported transactions": "正在分析导入的账单",
      "Reply completed": "回复完成",
      "Run ended without a completion call; counted as finished": "这轮没有明确收尾，按完成计",
      "The run ended without a completion call again.": "这轮又没有明确收尾。",
      "The run ended without a completion call; the next run picks up where it left off.":
        "这轮没有明确收尾，下一轮接着做。",
      // A run without a completion call goes on by itself (no count, no limit).
      "Continuing automatically": "自动接着做",
      // set_plan's event and the step events of the model's tools (model.ts): short titles,
      // never the instructions written for the model.
      "Plan set": "定了计划",
      "Searched the web": "搜了网页",
      "Asked you": "问了你",
      "Read a public webpage in the agent browser": "读了网页",
      "Save a persistent plan, comparison or report": "存了一份资料",
      "Read the authorized workspace sources": "读了授权的邮件、日历或文件",
      "Read the complete selected email thread": "读了邮件往来",
      "Import a selected email PDF attachment": "导入了邮件里的 PDF",
      "Inspect the supported fields of a PDF": "看了 PDF 的表单项",
      "Save a new PDF using only values supplied by the user": "填好了一份新的 PDF",
      "Prepare the exact email for a separate user review": "拟好了一封邮件等你审阅",
      "Prepare an event for a separate user review": "拟好了一个日程等你审阅",
      // set_account_pacing's event detail (service.ts setAccountPacing).
      "nothing written": "没有改动：这几项是你手动定的",
      "Run failed; next run scheduled": "这轮失败，已排下一轮",
      // An account task's run stopped by the model provider, the network or a hung desktop
      // (service.ts runStopped, runStoppedLabel): never a failure, it runs again by itself.
      "Run stopped by the infrastructure; it runs again by itself":
        "这轮被模型服务、网络或桌面打断，稍后自己接着做",
      // A run that reached its own time limit (service.ts
      // stoppedOutcome, runCappedLabel): it was working; the next run goes on.
      "Run reached its time limit; the next run goes on": "这一轮到了时长上限，下一轮接着做",
      // The desktop was held by another run (service.ts
      // desktopHeldLabel): never a failure, the task runs again when the desktop is free.
      "Desktop in use by another run; it runs again by itself":
        "桌面正被别的任务用着，空出来后自己接着做",
      // A standing task's run events (packages/domain/src/
      // standing.ts) and the founder request (jobs.ts founderRequestedLabel, requestFounder).
      "Keeps failing; still retrying by itself, the owner is told": "一直没跑成，还在自己重试",
      "Taken up again by itself after a failure": "出错停下后，自己重新接着做了",
      "Kept out of the chat: infrastructure trouble": "没放进聊天：这时系统出了状况",
      "Asked the founder": "请创始人帮忙",
      "Only a project asks the founder for work": "只有群里的任务能请创始人帮忙。",
      "This space has no founder": "这个空间还没有创始人。",
      "The founder does not ask itself": "创始人不用请自己帮忙。",
      "Paused after repeated failures": "连续失败已暂停",
      "Watch paused after repeated failures": "监控连续失败已暂停",
      "Check failed; retry scheduled": "检查失败，已排重试",
      "Checked for changes": "检查了有没有变化",
      "Saved the first observation": "记下了第一次的样子",
      "A meaningful change was found": "发现了有意义的变化",
      // Default plan steps (taskPlan in service.ts).
      "Understand the outcome": "弄清要的结果",
      "Plan the work": "安排步骤",
      "Use connected tools": "用已连接的工具去做",
      "Return a result": "交回结果",
      "Check the source": "查看来源",
      "Compare with the last observation": "和上次对比",
      "Report a meaningful change": "有意义的变化就汇报",
      "Find the source document": "找到原文件",
      "Fill a new copy": "填一份新的",
      "Prepare a reply": "准备回复",
      "Wait for your decision": "等你决定",
      "Record the outcome": "记下结果",
      "Validate transactions": "核对交易",
      "Calculate the summary": "算出汇总",
      "Save your tracker": "保存记账表",
      // Accounts and desktops.
      "The desktop took too long to start (tried twice); try again later.":
        "桌面启动超时（试了两次），稍后再试。",
      "The desktop did not answer in time; try again later.": "桌面没及时响应，稍后再试。",
      "Main conversation is unavailable. Check the Rich Threads connection and try again.":
        "主聊天暂时打不开：对话服务连不上，稍后再试。",
      "Task changed; refresh and try again": "任务刚有变化，刷新后再试。",
      // Redirecting a running task (apps/server/src/engine/service.ts redirect).
      Redirected: "收到新指示",
      // Account pacing and profile set by the task (service.ts setAccountPacing, recordAccountProfile).
      "Pacing set": "节奏已定",
      "Profile recorded": "账号档案已记",
      // The account's persona and its operating loop (v0.6, docs/accounts.md).
      "Persona set": "人设已记",
      "Goal changed": "长期目标改了",
      "Operating stopped": "经营停止",
      "Operating started again": "经营重新开始",
      "Taken over by the account's loop": "已并入号的长期经营",
      // The project's jobs (v0.6, apps/server/src/accounts/jobs.ts).
      "New job": "新的活",
      "Job changed": "活改了",
      "Job taken": "接了活",
      "Job declined": "没接活",
      "Job done": "活做完了",
      "Job progress": "活的进展",
      "Runs again now: a new job": "有新的活，马上再跑",
      "A job came while the run was ending; running again now.":
        "这一轮结束时来了新的活，马上再跑。",
      "Job not found": "找不到这件活。",
      "This job is finished; open it again before giving it out":
        "这件活已经结束了，先重新打开再派。",
      "This job is over": "这件活已经结束了。",
      "add or remove an account": "至少加一个号或撤一个号。",
      // Signing in with saved credentials (apps/server/src/credentials/tools.ts).
      "Sign-in recorded": "已记下登录情况",
      "Login field filled": "已填入登录信息",
      "Cookies imported": "已导入 Cookie",
      "A new instruction arrived while the run was ending; running again now.":
        "这一轮结束时收到新指示，马上再跑。",
      "Runs again now: the person sent a new instruction": "收到新指示，马上再跑",
      "[no action recorded this run]": "（这一轮没有记下动作）",
      "This task has ended; delegate a new one instead": "这个任务已经结束，要做请重新派一个。",
      "Task not found": "找不到这个任务。",
      "Could not redirect the task": "没能转告任务。",
      // Pausing and resuming from the chat (fork, pause from chat: conversation.ts pause_task,
      // resume_task; model.ts pause_task).
      "Could not pause the task": "没能暂停任务。",
      "Could not resume the task": "没能恢复任务。",
      "This account has no operating loop": "这个号没在经营。",
      "Give the task id or the account": "没说是哪个任务或哪个号。",
      "Paused as you said": "按你说的暂停了",
      "Only agent and plan tasks take new instructions; this task runs a fixed workflow. Change or cancel it instead.":
        "这类任务按固定流程跑，不接新指示；要改就修改或取消它。",
      // Credentials and account forms (apps/server/src/credentials/*, environments.ts,
      // computer-settings.ts): every fixed refusal in the owner's words.
      "Each site can have one login per account":
        "同一个网站在一个账号下只能有一份登录（子域名算同一个网站）。",
      "site must be a website address or domain with a registrable name, such as example.com or https://www.example.com/login":
        "网站要写成网址或域名，比如 example.com 或 https://www.example.com/login。",
      "username must be 1 to 256 characters without control characters":
        "用户名要 1 到 256 个字符，不能有控制字符。",
      "password must be 1 to 256 characters without control characters":
        "密码要 1 到 256 个字符，不能有控制字符。",
      "totpSeed must be a time-based (otpauth://totp) two-factor key":
        "两步验证密钥要是基于时间的那种（otpauth://totp）。",
      "totpSeed must be the two-factor secret key, not a code from the authenticator app":
        "两步验证这里要填密钥本身，不是验证器 App 里显示的验证码。",
      "totpSeed must be the two-factor secret key: base32 letters A-Z and digits 2-7, at least 16 of them, copied whole, or its otpauth://totp link":
        "两步验证密钥要完整复制：至少 16 位，只含字母 A-Z 和数字 2-7；也可以贴 otpauth://totp 链接。",
      "cookies must be a cookies JSON export: a list of cookies with name, value and domain, or an object with such a cookies list":
        "Cookie 要贴导出的 JSON：一组带 name、value、domain 的 Cookie，或包含这样一组 cookies 的对象。",
      "label must be 100 characters or fewer without control characters":
        "备注最多 100 个字符，不能有控制字符。",
      "usedBy must be an account of this project or the project": "只能给本群的账号或本群用。",
      "usedBy must name accounts of this project": "只能给本群的账号用。",
      "This credential changed while saving. Try again.": "保存时这一项刚被改过，再试一次。",
      "A site login is used by one account or by the project":
        "一份网站登录只能给一个账号或本群用。",
      // The mailbox form and sending through it.
      "kind must be one of the credential kinds": "这种凭据不认识。",
      "address must be an email address such as sales@example.com":
        "邮箱地址的格式不对，例如 sales@example.com。",
      "password is required for a mailbox": "要填密码或授权码。",
      "smtpHost is required": "要填发信服务器（SMTP）。",
      "smtpHost must be a server name such as smtp.example.com":
        "发信服务器要写服务器名，例如 smtp.example.com。",
      "imapHost must be a server name such as imap.example.com":
        "收信服务器要写服务器名，例如 imap.example.com。",
      "smtpPort must be a port between 1 and 65535": "SMTP 端口要在 1 到 65535 之间。",
      "imapPort must be a port between 1 and 65535": "IMAP 端口要在 1 到 65535 之间。",
      "A mailbox entry needs its password; delete it instead": "邮箱的密码不能清空；不要了就删除。",
      "The mailbox refused its password (SMTP sign-in failed)":
        "邮箱拒绝了密码（SMTP 登录失败）：检查授权码，或在邮箱设置里开启 SMTP。",
      "The mailbox refused its password (IMAP sign-in failed)":
        "邮箱拒绝了密码（IMAP 登录失败）：检查授权码，或在邮箱设置里开启 IMAP。",
      "The SMTP server could not be reached": "连不上发信服务器：检查服务器名和端口。",
      "The IMAP server could not be reached": "连不上收信服务器：检查服务器名和端口。",
      "The SMTP server refused the message": "发信服务器拒收了这封邮件。",
      "The project's mailbox changed. Prepare a new email.": "群的发信邮箱换过了，这封要重新准备。",
      "The project's mailbox changed. Prepare a new action.":
        "群的发信邮箱换过了，这封要重新准备。",
      "This mailbox has no IMAP server saved, so it only sends":
        "这个邮箱没填收信服务器，只能发信。",
      "Add a mailbox to the project or connect Google before preparing an email":
        "先在凭据里添加发信邮箱（或连接 Google），才能准备邮件。",
      // The review / approval routes (apps/server/src/actions.ts).
      "This review expired. Create a fresh proposal.":
        "这次审阅已过期，没有发出。请让它重新准备一份。",
      "This proposal changed. Open its latest review before deciding.":
        "这份内容已经改过了，请打开最新的审阅再决定。",
      "Resume the task before approving this action. Cancelled tasks cannot execute.":
        "先继续这个任务再同意；已取消的任务不能执行。",
      "Google is disconnected. Reconnect before approving this action.":
        "Google 已断开，重新连接后才能同意。",
      "Google account or connection changed. Prepare a new action for the connected account.":
        "Google 账号或连接换过了，要按现在连接的账号重新准备。",
      "Connect Google before preparing an action": "先连接 Google，才能准备这项操作。",
      "Prepared action could not be loaded": "准备好的操作读不出来，请再试一次。",
      "Action not found": "这项审阅已经不在了。",
      "Declined; no changes made": "已拒绝，没有改动任何东西。",
      "Approved; execution started": "已同意，开始执行。",
      "Execution failed": "执行失败。",
      "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY to connect Google":
        "服务器还没配置 Google 连接，请联系运维。",
      "This login was saved with another credential key and can't be read: enter its password and cookies again (or clear them), or delete it":
        "这份登录是用另一把凭据密钥存的，读不出来：重新填密码和 Cookie（或清除它们），或者删掉。",
      "A password needs the user name it belongs to": "有密码就要填它对应的用户名。",
      "A two-factor key needs the password it goes with": "有两步验证密钥就要有它对应的密码。",
      "A site login needs a password or cookies to sign in with":
        "网站登录至少要有密码或 Cookie 才能登录。",
      "Credential not found": "这项凭据已经不在了。",
      // The chat's cards.
      "Guide not found": "这张卡已经不在了。",
      "This card was already dealt with": "这张卡已经处理过了。",
      "Nothing to save": "先填一下再保存。",
      "code is required": "先填验证码。",
      "kind and for are required without a guide": "这张卡缺少信息，刷新后再试。",

      "before must be a cursor from an earlier page": "记录翻页出错，刷新后再试。",
      "Computer settings changed while saving. Try again.": "保存时设置刚被改过，再试一次。",
      "Environment not found": "这个账号已经不在了。",
      "The founder belongs to the space, in no project: move this account to 未分组 first":
        "创始人属于整个空间，不在任何群里：先把这个号退回未分组。",
      "The founder belongs to the whole space and joins no project; give it a job from the project instead":
        "创始人属于整个空间，不进任何群；要它做事，就在群里给它派活。",
      "Environment no longer exists": "这个账号已经不在了。",
      "An account can only be added to the current project from unassigned, or returned to unassigned from the current project":
        "账号只能从未分配加进当前群，或从当前群退回未分配。",
      "Send timezone and locale as strings or null": "时区和语言要填文字，或者留空。",
      "locale must be a language and region, such as en-US": "语言要写成语言加地区，比如 en-US。",
      "timezone must be an IANA zone name from the ICU list, such as America/Los_Angeles or Asia/Calcutta":
        "时区要写成 IANA 时区名，比如 America/Los_Angeles 或 Asia/Calcutta。",
      "Saved time zone and language can't be read with the server's current key. Enter both, or clear both, to replace them.":
        "存着的时区和语言用服务器现在的密钥读不出来：两个都重新填，或者都清空。",
      // The browser's own network errors (Chrome, Safari, Firefox).
      "TypeError: Failed to fetch": "连不上服务器，检查网络后再试。",
      "Failed to fetch": "连不上服务器，检查网络后再试。",
      "TypeError: Load failed": "连不上服务器，检查网络后再试。",
      "Load failed": "连不上服务器，检查网络后再试。",
      "NetworkError when attempting to fetch resource.": "连不上服务器，检查网络后再试。",
      "Network request failed": "连不上服务器，检查网络后再试。",
    } as Readonly<Record<string, string>>,
    /** Sentences recognised anywhere in a message (after 「出错了：」, inside a longer line). */
    sentences: {
      // The offline move refuses a target that already holds credentials.
      "The target credential scope is not empty": "目标项目里已经有凭据，不能把项目搬进去。",
      "The desktop took too long to start (tried twice); try again later.":
        "桌面启动超时（试了两次），稍后再试。",
      "The desktop did not answer in time; try again later.": "桌面没及时响应，稍后再试。",
      "Main conversation is unavailable. Check the Rich Threads connection and try again.":
        "主聊天暂时打不开：对话服务连不上，稍后再试。",
      "TypeError: Failed to fetch": "连不上服务器，检查网络后再试。",
      "Failed to fetch": "连不上服务器，检查网络后再试。",
      // Account pacing PATCH (apps/server/src/environments.ts pacingPatchSchema).
      "activeHours start must be before its end": "活动时段的起点要早于终点",
      "activeHours must be whole hours": "活动时段要填整点",
      "a kind is <site>/<action>, such as example.com/post":
        "动作写成 站点/动作，比如 example.com/post",
      "The server has no encryption key set, so it can't store these yet.":
        "服务器没设加密密钥，暂时存不了这些设置。",
    } as Readonly<Record<string, string>>,
    /** Account pacing fields in the server's validation messages (PATCH { pacing }). */
    pacingFields: {
      minGapMinutes: "间隔分钟",
      activeHours: "活动时段",
      "a cap": "每天上限",
      // Old set_account_pacing events (before caps by kind) still read in the timeline.
      maxCommentsPerDay: "每天评论上限",
      maxPostsPerDay: "每天发帖上限",
    } as Readonly<Record<string, string>>,
    pacingNegative: (field: string) => `${field}不能是负数`,
    pacingAtMost: (field: string, n: string) => `${field}最多 ${n}`,
    pacingAtLeast: (field: string, n: string) => `${field}至少 ${n}`,
    pacingWhole: (field: string) => `${field}要填整数`,
    capsKind: (key: string) => `上限「${key}」不是「网站域名/动作」的写法，例如 example.com/post。`,
    capsTwice: (kind: string) => `「${kind}」写了两个不同的上限。`,
    passwordMin: (n: string) => `密码至少 ${n} 位。`,
    /** Credentials: a cookies export with nothing of the login's site. */
    cookiesOffSite: (site: string) => `贴的 Cookie 里没有 ${site} 或它子域名的 Cookie。`,
    /** Credentials: a second login for the same site on one account or the project. */
    duplicateLogin: (site: string, where: "account" | "project" | "there") =>
      `${where === "account" ? "这个账号" : where === "project" ? "本群" : "那里"}已经有 ${site} 的登录了；要改请用「更换」。`,
    fieldsNotOfKind: "这些内容不属于这类凭据。",
    /** A schema refusal (zod) the server words in English: what was sent has the wrong shape. */
    invalidInput: "填的内容格式不对，检查后再试。",
    environmentExists: (name: string) => `已经有叫「${name}」的账号了。`,
    environmentsMax: (n: string) => `账号最多 ${n} 个。`,
    deleteBusy: (name: string) => `「${name}」的桌面正忙，或上次关闭还没确认，稍后再删。`,
    /** Any other English refusal on a credential or account form (none is known unmapped). */
    unmapped: "服务器没接受这次操作，检查填写的内容后再试。",
    passwordMax: (n: string) => `密码最多 ${n} 位。`,
    taskStatus: (status: string) => `任务${status}`,
    statusWords: {
      queued: "排队中",
      running: "运行中",
      paused: "已暂停",
      cancelled: "已取消",
      succeeded: "已完成",
      failed: "失败",
      scheduled: "已排期",
      waiting_input: "等你回答",
      waiting_approval: "等你审阅",
    } as Readonly<Record<string, string>>,
    repeats: (n: string) => `改成每 ${n} 分钟重复`,
    // A stop or rebuild refused while a run holds the desktop
    // (computer.ts DesktopHeldError, "Desktop in use by <title>").
    desktopHeldBy: (title: string) => `桌面正被「${title}」用着，等它空出来再试。`,
    runStarted: (n: string) => `第 ${n} 轮开始`,
    runFinishedNext: (n: string, next: string) => `第 ${n} 轮完成，下一轮 ${next}`,
    /** A tool's failure: never its name (fork, report line: no tool names for the person). */
    toolFailed: () => "有一步没成功",
    /** Old run events of the limits that are gone (fork, report line). */
    waitingAfterRuns: (n: string) => `自动接着做了 ${n} 次后停下等你`,
    waitingAfterWaits: (n: string) => `等了 ${n} 次后停下等你`,
    askedMoreWait: (n: string) => `任务要再等 ${n} 分钟`,
    continuing: () => "自动接着做",
    waitingMinutes: (n: string) => `等待 ${n} 分钟`,
    waitingPacing: (n: string) => `等待 ${n} 分钟 · 节奏`,
    /** A wait in the timeline: 「等待到 13:12」 (fork, report line). */
    waitingUntil: (clock: string, pacing: boolean) => `等待到 ${clock}${pacing ? " · 节奏" : ""}`,
    resumesAt: (at: string) => `${at} 继续`,
    /** Why a wait or a stopped run happened (「原因：网络连不上」). */
    blockedBy: (what: string) => `原因：${what}`,
    /** A provider's answer that its balance, quota or billing needs the owner. */
    providerQuota:
      "模型服务的余额或额度用完了：需要你到模型服务商那里充值或调整套餐，然后点「重试」。",
    /** A model or its key that is not configured on the server (Unknown provider, Invalid model
     * string, *_API_KEY is not set). */
    modelNotConfigured: "模型或密钥没配置好：需要你在设置里配好，然后点「重试」。",
    /** A run stopped because nothing moved for minutes (a desktop that stopped answering). */
    runIdle: "这轮好几分钟没有进展（桌面可能没响应），停下了。",
    /** A run stopped at its time cap. */
    runTooLong: "这轮跑得太久，到了上限，停下了。",
    /** A failure nobody has mapped yet (`failureText`); the raw text stays in the task's record. */
    failureUnknown: "出了一个没认出的错误，原文在任务记录里。",
    /** A model provider's refusal, by its error type (`providerErrorText`); never its own words. */
    providerError: {
      request: "模型服务没接受这次请求：请求的内容不合它的要求。这要改程序，改好后点「重试」。",
      auth: "模型服务不认现在配置的密钥：换一把能用的密钥，然后点「重试」。",
      permission: "模型服务不允许现在的密钥做这件事：换一把有权限的密钥，然后点「重试」。",
      notFound: "模型服务找不到配置的模型：改成它有的模型，然后点「重试」。",
      tooLarge: "这次发给模型服务的内容太大，它不收。",
      rateLimit: "模型服务暂时限流，过一会儿点「重试」。",
      server: "模型服务自己出了问题，过一会儿点「重试」。",
      /** A relay answered with nothing at all (`empty_stream`). */
      empty: "模型服务这次没有回话（空回复），过一会儿点「重试」。",
      other: (status: string) => `模型服务返回了错误（${status}）。`,
    },
    /** Old timeline titles that were a tool's instruction for the model. */
    planSet: "定了计划",
    searchedWeb: "搜了网页",
    askedYou: "问了你",
    finishing: "完成",
    savedOperatingPlan: "存了经营计划",
    setPacing: "定了这个号的节奏",
    recordedProfile: "记下了这个号的资料",
    reported: "汇报了一次",
    /** set_account_pacing's event detail, line by line. */
    pacingGap: (n: string) => `每两次之间至少隔 ${n} 分钟`,
    pacingComments: (n: string) => (n === "0" ? "不发评论" : `每天最多评论 ${n} 条`),
    pacingPosts: (n: string) => (n === "0" ? "不发帖" : `每天最多发帖 ${n} 条`),
    pacingHours: (start: string, end: string) => `当地 ${start}–${end} 点之间`,
    /** A cap by kind (platform-agnostic: `caps.<site>/<action>`); the kind is data, as sent. */
    pacingCap: (kind: string, n: string) =>
      n === "0" ? `不做 ${kind}` : `${kind} 每天最多 ${n} 次`,
    pacingCapWord: (kind: string) => `${kind} 每天上限`,
    pacingUnset: (field: string) => `${field}：不设`,
    pacingReason: (reason: string) => `理由：${reason}`,
    pacingOwnerKept: (fields: string) => `你手动定的保持不变：${fields}`,
    /** record_account_profile's event detail by site (platform-agnostic): the facts as read. */
    siteProfile: (site: string, facts: string) => `${site}：${facts}`,
    /** A report event's marks (service.ts report). */
    overPace: "（超出了这个号的节奏）",
    /** v0.6: what the action did to another account of the project. */
    siblingTouched: (name: string, link: string) => `碰到自己人：${name}${link ? ` ${link}` : ""}`,
    samePlace: (name: string, link: string) => `和 ${name} 进了同一处${link ? `：${link}` : ""}`,
    /** set_account_persona's event detail (accounts/operating.ts taskSetPersona). */
    personaVersion: (n: string, fields: string) => `第 ${n} 版：${fields}`,
    reviewPrepared: (account: string) => `已为 ${account} 准备好待审阅的内容`,
    requestFailed: (status: string) => `请求没成功（${status}），稍后再试。`,
    unreadableResponse: (status: string) => `服务器的回应读不出来（${status}）。`,
  },
  /** A task's open infrastructure incident, the fact the account row and the
   * task's line show while the task retries by itself (never in 需要你). */
  incidents: {
    /** What keeps blocking a task, as the owner reads it. */
    stuckOn: (part: string) => `卡在：${part}`,
    kinds: {
      desktop: "桌面没响应",
      network: "网络连不上",
      model: "模型服务连不上",
      rate_limit: "平台暂时限流",
      sign_in: "遇到登录页",
    } as Readonly<Record<IncidentKind, string>>,
    /** 「网络连不上（13:02 起）· 14:00 再试」; without a next time 「· 自己会再试」. */
    line: (what: string, since: string, next: string) =>
      `${what}${since ? `（${since} 起）` : ""} · ${next ? `${next} 再试` : "自己会再试"}`,
    /** The account row's flag: 「网络连不上 · 自己在重试」. */
    flag: (what: string) => `${what} · 自己在重试`,
    unknown: "出了点问题",
  },
  /** The desktop's picture at the moment
   * the AI could not go on (需要你, the desktop card), and the operator's 异常 list. */
  incidentShots: {
    thumb: "当时的画面",
    thumbAlt: (site: string) => `${site} 当时的画面`,
    open: "点开看大图",
    /** The 「当时的画面」 overlay's close. */
    close: "关闭大图",
    loading: "正在读取画面…",
    missing: "画面读不出来了（可能已超过 30 天）",
    title: "异常",
    hint: "近 30 天里 AI 自己处理不了的情况。系统异常（只有你能修）排在最前，标红。",
    empty: "近 30 天没有异常。",
    system: "系统异常",
    defaultProject: "默认项目",
    goneSpace: "（空间已不在）",
    noLine: "没有留下说明",
  },
  /** The project's jobs (「活」): the live panel's group, the
   * job detail, the account detail's 手上的活 and the chat's cards. */
  jobs: {
    railTitle: "活",
    archived: (n: number) => `已归档的活 (${n})`,
    status: {
      assigned: "已派",
      taken: "在做",
      declined: "没接",
      done: "做完了",
      dropped: "不做了",
    },
    dropped: {
      owner: "你撤下了",
      stopped: "这个号停止经营了",
      moved: "号已移走",
      removed: "号已删除",
    },
    declinedWith: (reason: string) => `没接：${reason}`,
    to: (names: string) => `派给${lead(names)}`,
    /** An assignee who is the space's founder: 「创始人 Founder_Ann」. */
    founderName: (name: string) => `创始人 ${name}`,
    toEveryone: (names: string) => (names ? `所有号都接（现在：${names}）` : "所有号都接"),
    nobody: "还没有号",
    nameSep: "、",
    countSep: " / ",
    counts: {
      working: (n: number) => `${n} 个在做`,
      declined: (n: number) => `${n} 个没接`,
      done: (n: number) => `${n} 个做完了`,
    },
    open: (title: string) => `查看活「${title}」`,
    panel: {
      /** The panel's title while it has no job to show. */
      title: "活",
      loading: "正在读取这件活…",
      gone: "这件活已经不在了。",
      brief: "你说的",
      due: "期限",
      noDue: "没定期限",
      accounts: "号",
      everyone: "所有号都接：之后加进群的号也会接。",
      insisted: "你看过它的理由，仍让它接",
      reason: (reason: string) => `理由：${reason}`,
      note: (note: string) => `它说：${note}`,
      actions: "为这件活做的动作",
      noActions: "还没有动作。",
      addAccount: "加号",
      addNone: "群里的号都已经在这件活上了。",
      remove: "撤下",
      edit: "改",
      save: "保存",
      cancel: "算了",
      titleLabel: "活名",
      briefLabel: "要做什么",
      dueLabel: "期限（可空）",
      close: "结束这件活",
      reopen: "重新打开",
      doneAt: (clock: string) => `${clock} 归档`,
      closedReason: (reason: string) => `结束的原因：${reason}`,
      saved: "已保存",
    },
    cards: {
      newJob: (title: string, names: string) => `新活「${title}」派给了${lead(names)}。`,
      newJobEveryone: (title: string) =>
        `新活「${title}」派给了这个群的所有号，之后加进来的号也接。`,
      assigned: (title: string, names: string) => `「${title}」现在派给${lead(names)}。`,
      insisted: (title: string, names: string) =>
        `「${title}」又派给了${lead(names)}：它会知道你看过它的理由。`,
      updated: (title: string) => `「${title}」改好了，号们马上就能看到。`,
      closed: (title: string) => `「${title}」结束了，已归档。`,
      saving: "正在派活…",
      failed: "这件活没派成",
      declined: (account: string, title: string, reason: string) =>
        `${account} 没接「${title}」：${clause(reason)}。要换个号，或者改改它的人设，跟我说一声就行。`,
      taken: (account: string, title: string) => `${account} 接了「${title}」。`,
      done: (title: string) => `「${title}」做完了，已归档。`,
      persona: (account: string, version: number, changed: string, reason: string) =>
        `${account} 的人设更新到第 ${version} 版：${changed}${clause(reason) ? `，${clause(reason)}` : ""}。`,
      view: "查看",
      look: "看看",
      quick: { otherAccount: "换个号", editPersona: "改人设", insist: "还是让它接" },
      say: {
        otherAccount: (title: string, account: string) =>
          `「${title}」换个号来做，别让 ${account} 接了。`,
        editPersona: (account: string) => `把 ${account} 的人设改一下：`,
        insist: (title: string, account: string) => `还是让 ${account} 接「${title}」。`,
      },
    },
    /** Under a job made while the project had no account (v0.6 account guide). */
    guide: {
      none: "这件活还没有号来做。先加一个号进这个群：",
      join: "把一个未分配的号加进来 ›",
      create: "新建一个号 ›",
      ready: (names: string) => `号到了：${names}。`,
      start: "让它开始接活",
      say: (title: string, names: string) =>
        `我把 ${names} 加进来了，去接「${title}」；这件活要用的网站还没登录的，给它弹登录卡。`,
    },
  },
  /** The account's persona, long-term goal, plan and jobs in its detail. */
  persona: {
    title: "人设",
    fields: { who: "是谁", voice: "说话方式", background: "背景", boundaries: "不碰什么" },
    byOwner: "你定的",
    byAi: (reason: string | null) => (reason ? `AI 定的 · ${reason}` : "AI 定的"),
    unset: "没写",
    empty: "还没有人设。号开始经营时，AI 会先按它现在的样子写一版。",
    edit: "改",
    save: "保存",
    cancel: "算了",
    saved: "人设已保存",
    hint: "空着就是不设。你写的这几项，AI 不会改。",
    history: (n: number) => `历史 ${n} 版`,
    hideHistory: "收起历史",
    versionLine: (version: number, who: string, clock: string) =>
      `第 ${version} 版 · ${who} · ${clock}`,
    byYou: "你改的",
    byTask: (title: string) => `任务「${title}」写的`,
    restored: (version: number) => `用回第 ${version} 版`,
    use: "用这一版",
    current: "当前",
  },
  /** 设置 → 所有空间 → 安全, the operator's secrets check. */
  security: {
    title: "安全",
    hint: "只显示位置和数量，不显示任何值。清理要在服务器上做。",
    refresh: "重新检查",
    checkedAt: (when: string) => `检查于 ${when}`,
    keyTitle: "凭据密钥",
    keyApart: "凭据库的密钥单独存放，不在数据目录里",
    keyInside: "凭据库的密钥在数据目录里：备份数据就带上了密钥",
    keyUnset: "没有设凭据密钥文件（演示模式）",
    plainTitle: "明文残留",
    plainClean: "数据库里没有找到明文密钥或带密码的地址",
    urlWithPassword: (where: string, n: number) => `${where}：${n} 条带密码的地址`,
    envSecret: (name: string, where: string, n: number) => `${where}：${n} 处原样出现 ${name}`,
    backupTitle: "备份",
    backupHolds: (path: string, n: number) => `${path}：含 ${n} 项密钥`,
    backupUnread: (path: string) => `${path}：读不了，没法检查`,
    backupClean: (n: number) => (n ? `其余 ${n} 份不含密钥` : "没有找到备份或 .env 副本"),
    loadError: "安全检查没有读到。",
  },
  /** The project conversation as a group: the
   * project's AI is its 运营专员, accounts and the founder speak as themselves. */
  /** The members bar's words. */
  members: {
    label: "成员",
    /** The line under Yuki, the main member, in the contact list. */
    mainLine: "有事跟我说就行",
    running: "正在做",
    waiting: "等着",
    idle: "停着",
    ops: "答你的话",
    founder: "创始人",
    noAccounts: "没有号",
    projectNeeds: (n: number) => `等你 ${n} 件`,
    projectRunning: (n: number) => `${n} 个在跑`,
    projectIdle: "没在跑",
    /** A run while the worker has no heartbeat (nothing moves; 进度汇报 says the same). Also
     * such a run's phase label wherever it shows (model.ts stalledPhase). */
    stalled: "后台停着",
    /** 「桌面没响应 2 小时了」 */
    blocked: (what: string, duration: string) => `${what} ${duration}了`,
    /** An account's standing loop that stopped (failed / paused). */
    loopStopped: "经营停了",
    loopPaused: "经营暂停了",
    /** A standing task of it runs without acting (`TaskPhase.behind`). */
    behind: (days: number) => `${days} 天没在网站上做事`,
    desktopOn: "桌面开着",
    stateWords: {
      needs: "要你",
      blocked: "卡住",
      running: "在做",
      waiting: "等着",
      idle: "停着",
    } as Record<"needs" | "blocked" | "running" | "waiting" | "idle", string>,
  },
  group: {
    ops: (project: string | null) => (project ? `${project} 运营专员` : "运营专员"),
    /** The hall's own assistant (the space's conversation). */
    hallOps: "Yuki",
    forProject: (project: string) => `为 ${project}`,
    inHall: (title: string) => `汇报了「${title}」，详情在 Yuki 的对话里。`,
    inHallNamed: (name: string, title: string) =>
      `创始人 ${name} 汇报了「${title}」，详情在 Yuki 的对话里。`,
    toHall: "去 Yuki 的对话 ›",
    everyone: "所有号",
    /** 运营专员's request: 「@创始人 Ann @Bob 请：发一帖」 (the mentions are drawn bold). */
    request: (title: string) => `请：${title}`,
    requestFor: (title: string, project: string) => `请（为 ${project}）：${title}`,
    updated: (title: string) => `「${title}」的要求改了。`,
    closed: (title: string) => `「${title}」收工了。`,
    taken: (title: string) => `接了：${title}`,
    declined: (title: string, reason: string) =>
      reason ? `没接「${title}」：${reason}` : `没接「${title}」。`,
    done: (title: string) => `「${title}」做完了。`,
    redirected: (title: string) => `转告了：${title}`,
    paused: (title: string) => `暂停了：${title}`,
    resumed: (title: string) => `恢复了：${title}`,
    members: "群成员",
    /** The hall made a project a request named, and handed a task to a project. */
    projectMade: (name: string) => `建好了群「${name}」`,
    projectThere: (name: string) => `群「${name}」已经有了`,
    toProject: (name: string) => `去 ${name} ›`,
    /** Whose a request is, and why. */
    routedTo: (name: string, why: string) => `归 ${name}：${why}`,
    founderTag: "创始人",
    details: "详情",
  },
  /** The space's founder: the 创始人 panel, the account
   * detail's 设为创始人, and the chat's speaker line. */
  /** What a task produced (the plan, comparison, report and finance cards in the
   * chat and the task detail). Their headings and keys come from the model and are humanized,
   * never shown raw (results/artifact-core.ts). */
  artifacts: {
    more: "查看完整结果",
    less: "收起",
    yes: "是",
    no: "否",
    empty: "—",
    listSep: "、",
    rowSep: "；",
    pairSep: "，",
    pair: (label: string, value: string) => `${label}：${value}`,
    kinds: { plan: "计划", comparison: "对比", finance: "账目", report: "报告" } as Record<
      string,
      string
    >,
    finance: {
      open: (title: string) => `打开账目：${title}`,
      source: "根据你导入的流水整理。",
      count: (n: number) => `${n} 笔流水，已分类汇总。`,
      income: "收入",
      spending: "支出",
      saved: "结余",
      currency: "原币种",
      name: "账目",
      tagline: "花在哪、省下多少、接下来怎么安排。",
      where: "钱花在了哪里",
      note: "金额按原币种计；只统计导入的日期范围。",
      goalSaved: "储蓄目标已存进目标里。",
      goalLabel: "把它变成一个储蓄目标",
      goalPlaceholder: "想存钱做什么？",
      goalCreate: "建立储蓄目标",
      goalDescription: (title: string, summary: string) => `来自「${title}」：${summary}`,
      goalMilestones: ["定一个储蓄目标", "每周看一次支出"],
      showTransactions: "查看流水",
      hideTransactions: "收起流水",
      first100: "只列出前 100 笔；合计包含全部流水。",
    },
  },
  /** The
   * web app's 进度汇报 page (what the tasks report, out of the chat) and its ways in. */
  progress: {
    title: "进度汇报",
    sub: "后台任务做了什么、做到哪了，按时间排好。聊天里只留对话。",
    /** The sidebar count, for a screen reader. */
    unread: (n: string) => `${n} 条新汇报`,
    /** A tab with unread reports, for a screen reader: 「要你看 · 1 条新汇报」. */
    tabUnread: (tab: string, n: number) => `${tab} · ${n} 条新汇报`,
    /** Beside a report that was new during this visit of the page. */
    newMark: "新",
    /** ⌘K: the command's hint. */
    hint: "后台任务的汇报和正在做的事",
    /** The properties pane's 汇报 section: the way to the page. */
    all: "全部汇报",
    now: "正在做",
    tabs: { all: "全部", attention: "要你看", external: "对外动作", byTask: "按任务" },
    empty: "还没有汇报",
    emptyLine: "后台任务做完一步、发出一条、遇到问题或要你拍板时，都会在这里汇报。",
    emptyTab: {
      /** Only the reports: an upstream review or another 需要你 item is not a report
       * (`needsMore` points there). */
      attention: "任务汇报里没有要你看的。",
      external: "还没有对外动作的汇报：任务在网站上发帖、评论、私信后会出现在这里。",
    },
    /** Under an empty 要你看 while 需要你 has items: opens 需要你. */
    needsMore: (n: number) => `需要你还有 ${n} 件 ›`,
    /** Beside 正在做 while the worker has no heartbeat (nothing in it moves); also the line of
     * a run then, wherever its phase shows (model.ts stalledPhase). */
    stalled: "后台停着，不会推进",
    /** 正在做's line of a run the worker does not carry on: where it stopped
     * (「停在第 3/5 步 · 打开评论区」). */
    stoppedAt: (step: string) => `停在${step}`,
    /** 按任务: a task's heading. */
    taskCount: (n: number) => `${n} 条`,
    older: "正在加载更早的汇报…",
    loadOlder: "加载更早的汇报",
    allLoaded: "没有更早的汇报了",
    loadError: (detail: string) => `汇报没加载出来：${detail}`,
    retry: "重试",
    /** The web's words where the phone's say a report comes back to the chat (the web chat shows
     * none): the 对话 panel without side chats, and a new project's empty chat. */
    web: {
      noSide: "这个群还没有侧聊。侧聊里派的任务，汇报在进度汇报里。",
      /** A credential card after 保存 / 我弄好了 (the phone's say 「结果会在这里告诉你」). */
      guide: {
        savedLogin: "我这就去登录。结果写在进度汇报里；还要你处理的，会出现在「需要你」。",
      },
      newProjectBody:
        "一句话就行：用哪个号做什么，什么目标都行，比如介绍一款产品、经营一个人设。怎么做、节奏由系统自己拟，先在进度汇报里给出一张「计划」再开始；它自己查不到的才会问你。谈定的内容会记进群资料。",
    },
  },
  /** The 下一步 bar above the chat and the live panel's summary line and
   * folding sections (focus-core.ts). `who` is 「<account name> 」 (with its space) or 「本群」. */
  focus: {
    label: "下一步",
    project: "本群",
    needsCode: (who: string, site: string) => `${who}登录 ${site} 要验证码`,
    suspended: (who: string, site: string) => `${who}在 ${site} 的号被封了`,
    wrongPassword: (who: string, site: string) => `${who}的 ${site} 密码不对`,
    noLogin: (who: string, site: string) => `${who}还没有 ${site} 的登录`,
    desktopError: (who: string) => `${who}的桌面出错了`,
    question: (title: string) => `「${title}」在等你回答`,
    review: (title: string) => `「${title}」等你审阅`,
    failed: (title: string) => `「${title}」没做成`,
    /** An account with nothing to work on; a standing loop that stopped. */
    idle: (who: string) => `${who}没在经营：给它一个长期目标或派活`,
    loopStopped: (title: string) => `「${title}」停了，号什么都不做`,
    loopPaused: (title: string) => `「${title}」暂停着，号什么都不做`,
    buttons: {
      fill: "去填",
      answer: "去回答",
      review: "去审阅",
      look: "去看看",
      goal: "定目标",
    },
    more: (n: number) => `还有 ${n} 件`,
    moreLabel: (n: number) => `还有 ${n} 件等你，打开「需要你」`,
    summary: {
      running: (n: number) => `${n} 个号在跑`,
      queued: (n: number) => `${n} 件排队中`,
      /** Tasks that go on by themselves later: a wait, a retry, a schedule (their teal light). */
      later: (n: number) => `${n} 件等下一轮`,
      doneToday: (n: number) => `今天做了 ${n} 件`,
      waiting: (n: number) => `${n} 件等你`,
      quiet: "现在没什么事",
    },
    sections: {
      tasks: (n: number) => `任务 (${n})`,
      reports: (n: number) => `汇报 (${n})`,
    },
  },
  lights: {
    red: "红灯",
    amber: "琥珀灯",
    /** A run or a queued task (one colour; a queued one does not run yet): never just 「在跑」. */
    blue: "在跑或排队中",
    teal: "在等下一轮",
    grey: "灰灯",
    hollow: "空心灯",
  },
};

export type Strings = typeof zh;
/** The strings in use. Switching the language = pointing this (and `phaseWords`) elsewhere. */
export const t: Strings = zh;

/** How long the background worker has been stopped (down bar, settings): 「3 分钟」, 「1 小时 20
 * 分钟」, where the rail's short 「还剩 13 分」 keeps `phaseWords`. */
export const stoppedForWords: TaskPhaseWords = { ...phaseWords, minutes: t.downBar.minutes };

/**
 * A server report label in the client's words: the fixed English labels map through
 * `t.reportLabels` and `t.reportPatterns`; "Plan v2" → 计划第 2 版, "Run 3 finished" → 第 3 轮完成, a
 * " · over pace" suffix → 「 · 超出节奏」. Anything else (a label already in Chinese, a future
 * label) is shown as it is. A wait is never a report, so no wait label maps here.
 */
export function reportLabel(
  title: string,
  action?: { site: string; action: string } | null,
): string {
  const words = t.reportLabels;
  const patterns = t.reportPatterns;
  const trimmed = title.trim();
  const over = / · over pace$/i.exec(trimmed);
  const unpaced = over ? trimmed.slice(0, over.index) : trimmed;
  // What an action did to the project's other accounts.
  const touched = / · sibling touched$/.exec(unpaced);
  const same = / · same place as (.+)$/.exec(unpaced);
  const marked = touched ?? same;
  const base = marked ? unpaced.slice(0, marked.index) : unpaced;
  const mark = touched ? patterns.siblingTouched : same ? patterns.samePlace(same[1]) : "";
  const suffix = `${mark}${over ? patterns.overPace : ""}`;
  let label: string;
  const exact = Object.hasOwn(words, base) ? words[base] : undefined;
  // An action card names its action (in Chinese when common)
  // and its site.
  if (base === "Action" && action)
    return `${patterns.action(actionWord(action.action) || (words.Action ?? base), action.site)}${suffix}`;
  const plan = /^Plan v(\d+)$/.exec(base);
  const persona = /^Persona v(\d+)$/.exec(base);
  const run = /^Run (\d+) finished$/.exec(base);
  if (typeof exact === "string") label = exact;
  else if (plan) label = patterns.planVersion(plan[1]);
  else if (persona) label = patterns.personaVersion(persona[1]);
  else if (run) label = patterns.runFinished(run[1]);
  else label = base;
  return `${label}${suffix}`;
}

/** An action word in Chinese when it is a common one (post → 发帖, upvote → 点赞); any other word
 * the AI used stays as it is. Case and spaces do not matter. */
export function actionWord(action: string): string {
  const word = action.trim();
  const key = word.toLowerCase();
  return Object.hasOwn(t.actionWords, key) ? t.actionWords[key] : word;
}

/** A task's title as the owner reads it: an account's loop the server titled 「经营 · <name>」
 * before 2026-10-16 reads 「<name> 的日常运营」, as the new ones are titled. */
export function taskTitleText(title: string): string {
  const prefix = t.taskTitle.oldLoopPrefix;
  const name = title.startsWith(prefix) ? title.slice(prefix.length).trim() : "";
  return name ? t.taskTitle.loop(name) : title;
}

/** Where a file came from (`Artifact.source`, written by the server) in the client's words:
 * 「Uploaded by you」, 「Browser · <id>」, 「Filled from <name>」, 「Computer (<name>): <path>」.
 * Anything else (「Gmail · <subject>」, a future source) is shown as it is. */
export function fileSourceText(source: string): string {
  const words = t.fileSheet.sources;
  const text = source.trim();
  if (text === "Uploaded by you") return words.uploaded;
  const browser = /^Browser · (.+)$/.exec(text);
  if (browser) return words.browser(browser[1]);
  const filled = /^Filled from (.+)$/.exec(text);
  if (filled) return words.filled(filled[1]);
  const computer = /^Computer \((.+?)\): (.+)$/.exec(text);
  if (computer) return words.computer(computer[1] === "default" ? null : computer[1], computer[2]);
  return source;
}

/** A time the server wrote as an ISO timestamp (「Resumes at
 * 2026-10-12T16:50:00.719Z」) as the clock the rest of the app shows (16:50, 明天 16:50). */
function isoClock(value: string): string {
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value.trim());
  return iso && !Number.isNaN(Date.parse(value))
    ? clockLabel(value, Date.now(), phaseWords)
    : value;
}
/** The incident word of a kind the server sent (「网络连不上」). */
export function incidentWord(kind: string): string {
  return Object.hasOwn(t.incidents.kinds, kind)
    ? t.incidents.kinds[kind as IncidentKind]
    : t.incidents.unknown;
}
/** A pacing field's name in the client's words (「间隔分钟」). */
const pacingFieldWord = (field: string) =>
  field.startsWith("caps.")
    ? t.server.pacingCapWord(field.slice(5))
    : (t.server.pacingFields[field] ?? field);
/** Persona parts as the server lists them (「who, voice」) in the owner's words (「是谁、说话方式」). */
const personaFieldWords = (list: string) =>
  list
    .split(/,\s*/)
    .map((field) =>
      Object.hasOwn(t.persona.fields, field)
        ? t.persona.fields[field as keyof typeof t.persona.fields]
        : field,
    )
    .join("、");
/** One line of set_account_pacing's event (service.ts setAccountPacing). */
function pacingSetLine(field: string, value: string): string {
  if (value === "unset") return t.server.pacingUnset(pacingFieldWord(field));
  if (field === "minGapMinutes") return t.server.pacingGap(value);
  if (field === "maxCommentsPerDay") return t.server.pacingComments(value);
  if (field === "maxPostsPerDay") return t.server.pacingPosts(value);
  if (field.startsWith("caps.")) return t.server.pacingCap(field.slice(5), value);
  const hours = /^(\d+)-(\d+)$/.exec(value);
  return hours ? t.server.pacingHours(hours[1], hours[2]) : `${pacingFieldWord(field)}：${value}`;
}
/** record_account_profile's event (service.ts recordAccountProfile): `<site>: <facts as JSON>`;
 * the facts read as 「名 值」 pairs, as the task wrote them (data, not translated). */
function siteProfileLine(site: string, json: string): string {
  try {
    const facts = JSON.parse(json) as Record<string, unknown>;
    return t.server.siteProfile(
      site,
      Object.entries(facts)
        .map(([key, value]) => `${key} ${String(value)}`)
        .join(t.common.sep),
    );
  } catch {
    return t.server.siteProfile(site, json);
  }
}
/** Anchored patterns of `serverLine`, each producing the client's words. */
const serverLinePatterns: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^Password must be at least (\d+) characters\.?$/, (m) => t.server.passwordMin(m[1])],
  // An entry sealed with another key than the one the move was given.
  [
    /^Credential entry (.+) does not open with this key$/,
    (m) => `凭据「${m[1]}」用这把密钥打不开。`,
  ],
  // A cap the server cannot key by a site's registrable domain.
  [
    /^caps: "(.+)" is not <site>\/<action> with a website's domain, such as example\.com\/post$/,
    (m) => t.server.capsKind(m[1]),
  ],
  [/^caps: two keys name the kind (.+) with different values$/, (m) => t.server.capsTwice(m[1])],
  [/^Password must be at most (\d+) characters\.?$/, (m) => t.server.passwordMax(m[1])],
  [
    /^Task ([a-z_]+)$/,
    (m) =>
      Object.hasOwn(t.server.statusWords, m[1])
        ? t.server.taskStatus(t.server.statusWords[m[1]])
        : m[0],
  ],
  [/^Repeats every (\d+) min$/, (m) => t.server.repeats(m[1])],
  [/^Desktop in use by (.+)$/, (m) => t.server.desktopHeldBy(m[1])],
  [/^Run (\d+) started$/, (m) => t.server.runStarted(m[1])],
  [/^Run (\d+) finished; next run (.+)$/, (m) => t.server.runFinishedNext(m[1], isoClock(m[2]))],
  [/^Run (\d+) finished$/, (m) => t.reportPatterns.runFinished(m[1])],
  [
    /^Waiting for you after (\d+) automatic continuations?$/,
    (m) => t.server.waitingAfterRuns(m[1]),
  ],
  // Old run events of the limits that are gone (fork, report line).
  [/^Waiting for you after (\d+) waits?$/, (m) => t.server.waitingAfterWaits(m[1])],
  [/^The task asked to wait (\d+) minutes? more\.$/, (m) => t.server.askedMoreWait(m[1])],
  [/^Continuing automatically \((\d+)\/(\d+)\)$/, () => t.server.continuing()],
  // Old step events whose title was the tool's instruction for the model.
  [/^Make a concrete plan for the delegated outcome\b/, () => t.server.planSet],
  [/^Search the public web\b/, () => t.server.searchedWeb],
  [/^Pause for (a fact or decision|missing)\b/, () => t.server.askedYou],
  [/^Finish only when the requested outcome\b/, () => t.server.finishing],
  [/^Save the operating plan\b/, () => t.server.savedOperatingPlan],
  [/^Record the pacing you decided\b/, () => t.server.setPacing],
  [/^Record this account's own facts\b/, () => t.server.recordedProfile],
  [/^Send the person a report\b/, () => t.server.reported],
  // set_account_pacing and record_account_profile event details.
  [
    /^(minGapMinutes|maxCommentsPerDay|maxPostsPerDay|activeHours|caps\.\S+): (\S+)$/,
    (m) => pacingSetLine(m[1], m[2]),
  ],
  [/^reason: (.*)$/, (m) => t.server.pacingReason(m[1])],
  [
    /^set by the person, left as they are: (.+)$/,
    (m) => t.server.pacingOwnerKept(m[1].split(/,\s*/).map(pacingFieldWord).join("、")),
  ],
  [/^([a-z0-9-]+(?:\.[a-z0-9-]+)+): (\{.*\})$/, (m) => siteProfileLine(m[1], m[2])],
  [/^\[pacing exceeded: .*\]$/, () => t.server.overPace],
  [
    /^\[not confirmed: the run did not (?:look at it|open its address)\b.*\]$/,
    () => t.reportCard.unconfirmedWhy.unverified,
  ],
  [/^\[not confirmed: .*\]$/, () => t.reportCard.unconfirmed],
  // Set_account_persona's event detail and report_to_user's sibling marks.
  [
    /^v(\d+): ((?:who|voice|background|boundaries)(?:, (?:who|voice|background|boundaries))*)$/,
    (m) => t.server.personaVersion(m[1], personaFieldWords(m[2])),
  ],
  [
    /^set by the owner, left as they are: (.+)$/,
    (m) => t.server.pacingOwnerKept(personaFieldWords(m[1])),
  ],
  [
    /^\[sibling touched: (.+?)(?: (https?:\/\/\S+))?\]$/,
    (m) => t.server.siblingTouched(m[1], m[2] ?? ""),
  ],
  [/^\[same place as (.+?): (.*)\]$/, (m) => t.server.samePlace(m[1], m[2])],
  [/^Waiting (\d+) minutes? \(pacing\)$/, (m) => t.server.waitingPacing(m[1])],
  [/^Waiting (\d+) minutes?$/, (m) => t.server.waitingMinutes(m[1])],
  [/^Resumes at (.+)$/, (m) => t.server.resumesAt(isoClock(m[1]))],
  [/^Blocked: ([a-z_]+)$/, (m) => t.server.blockedBy(incidentWord(m[1]))],
  [/^Plan v(\d+)$/, (m) => t.reportPatterns.planVersion(m[1])],
  [/^Review prepared for (.+)$/, (m) => t.server.reviewPrepared(m[1])],
  [/^Request failed \((\d+)\)$/, (m) => t.server.requestFailed(m[1])],
  [
    /^The server returned an unreadable response \((\d+)\)\.$/,
    (m) => t.server.unreadableResponse(m[1]),
  ],
  [/^cookies holds no cookie of (.+) or its subdomains$/, (m) => t.server.cookiesOffSite(m[1])],
  [
    /^There is already a (.+) login for this (account|project); replace it instead$/,
    (m) => t.server.duplicateLogin(m[1], m[2] as "account" | "project"),
  ],
  [
    /^There is already a (.+) login there; replace it instead$/,
    (m) => t.server.duplicateLogin(m[1], "there"),
  ],
  [/^Those fields do not belong to an? \S+ entry$/, () => t.server.fieldsNotOfKind],
  [/^Invalid input\b.*$/, () => t.server.invalidInput],
  [/^An environment named "(.*)" already exists$/, (m) => t.server.environmentExists(m[1])],
  [/^Environments are limited to (\d+)$/, (m) => t.server.environmentsMax(m[1])],
  [
    /^The desktop of environment "(.*)" is busy or its last stop was not confirmed\. Retry the delete shortly\.$/,
    (m) => t.server.deleteBusy(m[1]),
  ],
  [/^([a-z][a-z0-9_]*) failed$/, () => t.server.toolFailed()],
  // A model or key that is not configured (tanstack-agent.ts; the owner-only
  // failures of packages/domain/src/standing.ts), never shown in English.
  [/^Unknown provider\b/, () => t.server.modelNotConfigured],
  // runDeadline (model.ts): a run with no progress (a desktop that stopped answering) or past its cap.
  [/^Model run timed out: no progress\b/, () => t.server.runIdle],
  [/^Model run timed out\b/, () => t.server.runTooLong],
  [/^Invalid model string\b/, () => t.server.modelNotConfigured],
  [/\b[A-Z][A-Z0-9_]*_API_KEY is not set\b/, () => t.server.modelNotConfigured],
];

// Longest first, so "TypeError: Failed to fetch" wins over "Failed to fetch".
const serverSentenceKeys = Object.keys(t.server.sentences).sort((a, b) => b.length - a.length);

/** Field rules recognised anywhere in a line: the server joins several with "; ". */
const pacingField = "(minGapMinutes|activeHours|a cap)";
const serverInlinePatterns: [RegExp, (match: string, ...groups: string[]) => string][] = [
  [
    new RegExp(`\\b${pacingField} must be at most (\\d+)`, "g"),
    (_m, field, n) => t.server.pacingAtMost(t.server.pacingFields[field] ?? field, n),
  ],
  [
    new RegExp(`\\b${pacingField} must be at least (\\d+)`, "g"),
    (_m, field, n) => t.server.pacingAtLeast(t.server.pacingFields[field] ?? field, n),
  ],
  [
    new RegExp(`\\b${pacingField} must not be negative`, "g"),
    (_m, field) => t.server.pacingNegative(t.server.pacingFields[field] ?? field),
  ],
  [
    new RegExp(`\\b${pacingField} must be a whole number`, "g"),
    (_m, field) => t.server.pacingWhole(t.server.pacingFields[field] ?? field),
  ],
];

function serverLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  const exact = Object.hasOwn(t.server.lines, trimmed) ? t.server.lines[trimmed] : undefined;
  if (typeof exact === "string") return exact;
  for (const [pattern, words] of serverLinePatterns) {
    const match = pattern.exec(trimmed);
    if (match) return words(match);
  }
  let out = line;
  for (const sentence of serverSentenceKeys)
    if (out.includes(sentence)) out = out.split(sentence).join(t.server.sentences[sentence]);
  for (const [pattern, words] of serverInlinePatterns)
    out = out.replace(pattern, (match, ...groups: unknown[]) =>
      words(match, ...groups.filter((group): group is string => typeof group === "string")),
    );
  return out;
}

/** A wait note or a finish summary as the person reads it: the run's own words, and
 * apart from them, in the client's words, the server's line that an action of that run is not
 * confirmed (service.ts markUnconfirmed); "" when there is none. */
export function runNoteView(note: string): { text: string; unconfirmed: string } {
  const lines = note.split("\n");
  const mark = lines.find((line) => /^\[not confirmed: .*\]$/.test(line.trim()));
  if (!mark) return { text: note, unconfirmed: "" };
  return {
    text: lines
      .filter((line) => line !== mark)
      .join("\n")
      .trimEnd(),
    unconfirmed: serverText(mark.trim()),
  };
}

/**
 * Fixed English from the server or the browser in the client's words, line by line: a whole
 * line that is a known message or timeline title (「Changed by you」 → 你改的, 「Task paused」 →
 * 任务已暂停, 「Repeats every 120 min」 → 改成每 120 分钟重复), or a known error sentence inside a
 * longer line (「出错了：TypeError: Failed to fetch」). Anything else (what the model wrote, a
 * message nobody has mapped yet) is kept as it is.
 */
export function serverText(text: string): string {
  if (!text) return text;
  return text.split("\n").map(serverLine).join("\n");
}

/**
 * A task's failure (its `error`, the 出问题 outcome) in the client's words: `serverText`, and a
 * model provider's balance, quota or billing answer (`providerQuotaPattern`) as the owner's plain
 * reason. Only for a failure: a report, a step or anything the run wrote that mentions billing
 * stays as written (`serverText`).
 */
export function failureText(text: string): string {
  if (!text) return text;
  // A line still in English (nobody mapped it) is left out when another line
  // says why in the owner's words, else the failure reads as one Chinese line; the raw text stays
  // in the task's record (`failureDetailText` in the timeline).
  const lines = text.split("\n").map(failureLine);
  const words = lines.filter((line) => !englishOnly(line));
  if (words.length === lines.length) return words.join("\n");
  return words.some((line) => line.trim()) ? words.join("\n") : t.server.failureUnknown;
}
/** A failure in a timeline event's detail: as `failureText`, but a line nobody has mapped stays
 * as written there (the record of the run), not the Chinese fallback. */
export function failureDetailText(text: string): string {
  if (!text) return text;
  return text.split("\n").map(failureLine).join("\n");
}
function failureLine(line: string): string {
  // The part that keeps blocking a task, in the owner's words.
  const blocked = /^Blocked: ([a-z_]+)$/.exec(line.trim());
  if (blocked) return t.incidents.stuckOn(incidentWord(blocked[1] ?? ""));
  return providerQuotaPattern.test(line)
    ? t.server.providerQuota
    : (providerErrorText(line) ?? serverLine(line));
}
/** A line with English words and no Chinese at all. */
function englishOnly(text: string): boolean {
  return /[A-Za-z]{2,}[^　-鿿]*\s[A-Za-z]{2,}/.test(text) && !/[　-鿿]/.test(text);
}

type ProviderErrorKind = Exclude<keyof typeof zh.server.providerError, "other">;
/** Error types as the providers name them (Anthropic and OpenAI-style `type`, Google `status`). */
const providerErrorTypes: Readonly<Record<string, ProviderErrorKind>> = {
  invalid_request_error: "request",
  INVALID_ARGUMENT: "request",
  FAILED_PRECONDITION: "request",
  authentication_error: "auth",
  UNAUTHENTICATED: "auth",
  permission_error: "permission",
  PERMISSION_DENIED: "permission",
  not_found_error: "notFound",
  NOT_FOUND: "notFound",
  request_too_large: "tooLarge",
  rate_limit_error: "rateLimit",
  RESOURCE_EXHAUSTED: "rateLimit",
  api_error: "server",
  overloaded_error: "server",
  server_error: "server",
  INTERNAL: "server",
  UNAVAILABLE: "server",
};
const providerErrorKind = (status: number): ProviderErrorKind | null => {
  if (status === 400 || status === 422) return "request";
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "notFound";
  if (status === 413) return "tooLarge";
  if (status === 429) return "rateLimit";
  if (status >= 500 && status < 600) return "server";
  return null;
};

/**
 * A model provider's refusal of a request, as the provider SDKs put it in a failed run's error
 * (`400 {"type":"error","error":{"type":"invalid_request_error",…}}`, `401 Incorrect API key…`,
 * `{"error":{"code":400,…,"status":"INVALID_ARGUMENT"}}`), in the owner's words: by the error's
 * type when it names one, else by its status. Null for a line that is not one.
 */
export function providerErrorText(line: string): string | null {
  const text = line.trim();
  // A relay that answered with no events at all says only this, with no status.
  if (/^empty[ _]stream$/i.test(text)) return t.server.providerError.empty;
  const status = /^(\d{3})\b/.exec(text)?.[1] ?? /^\{.*"code":\s*(\d{3})\b/.exec(text)?.[1] ?? null;
  if (!status) return null;
  // A gateway relaying its upstream's failure: the provider behind it, which goes away by itself.
  if (/\bupstream[ _](?:request|error)\b/i.test(text)) return t.server.providerError.server;
  const types = [...text.matchAll(/"(?:type|status|code)":\s*"([A-Za-z_]+)"/g)].map((m) => m[1]);
  const byType = types.map((type) => providerErrorTypes[type]).find(Boolean);
  const byStatus = providerErrorKind(Number(status));
  // A generic "invalid request" type yields to a status that says more (404: no such model).
  const kind = byType === "request" && byStatus ? byStatus : (byType ?? byStatus);
  return kind ? t.server.providerError[kind] : t.server.providerError.other(status);
}

/** How a report's text reads: the 出问题 outcome ("Needs attention", the server's announce of a
 * failed task) carries the task's failure (`failureText`); every other report is what the run
 * wrote (`serverText`). */
export function reportWords(title: string | undefined): (text: string) => string {
  return title === "Needs attention" ? failureText : serverText;
}

/** A task's rhythm word: its interval when it repeats; an account's task that does not repeat
 * goes on until done or stopped (持续进行); any other one-off task is 一次性. */
export function taskRhythm(task: Pick<AgentTask, "repeatMinutes" | "input">): string {
  if (task.repeatMinutes || showsSteps(task)) return rhythmLabel(task.repeatMinutes, phaseWords);
  return t.taskCard.ongoing;
}

/**
 * A refusal from a credential or account form in the owner's words: `serverText` first; a
 * refusal that is still an English sentence (one nobody has mapped yet) reads as the Chinese
 * `t.server.unmapped`, so the form never shows English (all UI text is Chinese).
 */
export function refusalText(message: string): string {
  const text = serverText(message);
  return englishOnly(text) ? t.server.unmapped : text;
}
