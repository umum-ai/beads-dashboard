/** Top bar: brand, project switcher, view tabs, live indicator, board settings, actor, language, theme. */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { language, t, toggleLanguage } from "../i18n/index.ts";
import { actor, databases, meta } from "../state/meta.ts";
import { actorPref, setActor, theme, toggleTheme } from "../state/prefs.ts";
import { currentDb, hrefFor, navigate, onLinkClick, route } from "../state/route.ts";
import { BoardSettings } from "./BoardSettings.tsx";
import { LiveIndicator } from "./LiveIndicator.tsx";
import { Popover } from "./Popover.tsx";
import { toggleHelp } from "./ShortcutsHelp.tsx";

function SunIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 9.8A5.6 5.6 0 0 1 6.2 2.5a5.6 5.6 0 1 0 7.3 7.3Z"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function PersonIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5.5" r="2.8" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M2.5 14c.6-2.9 2.6-4.3 5.5-4.3s4.9 1.4 5.5 4.3"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

function ProjectSwitcher(): JSX.Element {
  const list = databases.value;
  const db = currentDb.value;
  const info = list.find((d) => d.name === db);
  const onChange = (event: Event) => {
    const next = (event.currentTarget as HTMLSelectElement).value;
    const r = route.value;
    const kind = r.kind === "epics" ? "epics" : "board";
    navigate({ kind, db: next }, { keepFilters: false });
  };
  return (
    <div class="project">
      <span class="project__dot" data-state={info?.state ?? "unknown"} aria-hidden="true" />
      <select
        class="select project__select"
        aria-label={t("header.project")}
        data-testid="project-switcher"
        value={db ?? ""}
        onChange={onChange}
        disabled={list.length === 0}
      >
        {list.length === 0 ? <option value="">{t("header.noDatabases")}</option> : null}
        {db && !list.some((d) => d.name === db) ? <option value={db}>{db}</option> : null}
        {list.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function ViewTabs(): JSX.Element | null {
  const db = currentDb.value;
  if (!db) return null;
  const r = route.value;
  const onBoard = r.kind === "board" || r.kind === "issue";
  const onEpics = r.kind === "epics" || r.kind === "epicsIssue";
  return (
    <nav class="tabs" aria-label={t("nav.board")}>
      <a
        class="tab"
        href={hrefFor({ kind: "board", db })}
        aria-current={onBoard ? "page" : undefined}
        data-testid="tab-board"
        onClick={(e) => onLinkClick(e, { kind: "board", db })}
      >
        {t("nav.board")}
      </a>
      <a
        class="tab"
        href={hrefFor({ kind: "epics", db })}
        aria-current={onEpics ? "page" : undefined}
        data-testid="tab-epics"
        onClick={(e) => onLinkClick(e, { kind: "epics", db })}
      >
        {t("nav.epics")}
      </a>
    </nav>
  );
}

function ActorSetting(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const current = actor.value;
  const fallback = meta.value?.actorDefault ?? "bddb";
  const openPanel = () => {
    setDraft(actorPref.value ?? "");
    setOpen(true);
  };
  const save = (event: Event) => {
    event.preventDefault();
    setActor(draft);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      label={t("header.actor")}
      testId="actor-popover"
      trigger={
        <button
          type="button"
          class="btn btn--ghost"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={t("header.actor.help")}
          data-testid="actor-button"
          onClick={() => (open ? setOpen(false) : openPanel())}
        >
          <PersonIcon />
          <span class="ellipsis" style="max-width: 120px">
            {current}
          </span>
        </button>
      }
    >
      <form onSubmit={save}>
        <p class="pop__title">{t("header.actor")}</p>
        <p class="pop__help">{t("header.actor.help")}</p>
        <div class="pop__row">
          <input
            class="input"
            type="text"
            value={draft}
            placeholder={t("header.actor.placeholder")}
            aria-label={t("header.actor")}
            data-testid="actor-input"
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" class="btn btn--primary">
            {t("header.actor.save")}
          </button>
        </div>
        <div class="pop__row" style="margin-top: var(--s-2)">
          <button
            type="button"
            class="btn btn--ghost"
            onClick={() => {
              setActor(null);
              setOpen(false);
            }}
          >
            {t("header.actor.reset", { actor: fallback })}
          </button>
        </div>
      </form>
    </Popover>
  );
}

export function Header(): JSX.Element {
  const dark = theme.value === "dark";
  const lang = language.value;
  const db = currentDb.value ?? meta.value?.defaultDatabase ?? "";
  return (
    <header class="header" data-testid="header">
      <a
        class="brand"
        href={hrefFor({ kind: "home" }, false)}
        onClick={(e) => {
          if (db) onLinkClick(e, { kind: "board", db });
        }}
      >
        {t("app.name")}
        <span class="brand__tag">{t("app.tagline")}</span>
      </a>
      <ProjectSwitcher />
      <ViewTabs />
      <span class="header__spacer" />
      <LiveIndicator />
      <span class="header__sep" aria-hidden="true" />
      <div class="header__group">
        {currentDb.value ? <BoardSettings db={currentDb.value} /> : null}
        <ActorSetting />
        <button
          type="button"
          class="btn btn--ghost lang-btn"
          aria-label={t("header.language")}
          title={lang === "en" ? t("header.language.ru") : t("header.language.en")}
          data-testid="lang-toggle"
          onClick={toggleLanguage}
        >
          {lang.toUpperCase()}
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label={t("help.title")}
          title={t("help.title.hint")}
          data-testid="help-button"
          onClick={toggleHelp}
        >
          <span aria-hidden="true">?</span>
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label={dark ? t("header.theme.toLight") : t("header.theme.toDark")}
          title={dark ? t("header.theme.toLight") : t("header.theme.toDark")}
          data-testid="theme-toggle"
          onClick={toggleTheme}
        >
          {dark ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}
