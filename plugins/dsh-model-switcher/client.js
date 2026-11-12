/* Public Harness client module. Credentials remain in the host process. */
window.__ModuleLoader__.load({
  id: 'dsh-model-switcher',
  factory(require) {
    const React = require('react');
    const routeOf = (selection, hosts) => {
      const host = hosts.find(item => item.provider === selection?.provider);
      // Keep removed/unavailable models bound so their conversation stays gated.
      return host && typeof selection?.model === 'string' && selection.model ? { host, model: selection.model } : null;
    };
    const routeKey = route => route ? `${route.host.id}/${route.model}` : null;
    const transitioning = status => /^(checking|waiting|unloading|releasing|loading)$/.test(status?.phase || '');
    const readyFor = (status, route) => status?.applies !== false && status?.catalogReady === true &&
      status.models?.some(model => model.id === route?.model) && status?.backendReady === true && status.activeModel === route?.model &&
      status.gatewayId === route?.host.gatewayId && /^(idle|ready|serving)$/.test(status.phase) && !status.error &&
      !(status.activeRequests > 0 && status.desiredModel && status.desiredModel !== status.activeModel);
    const hostTitle = host => `${host.label} (${new URL(host.url).host})`;

    /** Opening a conversation only inspects status; switching requires an explicit choice. */
    function createController({ directory, select, call, blocks, sessionId, hosts: initialHosts,
      interval = 1500, timer = setInterval, clearTimer = clearInterval, now = Date.now }) {
      let hosts = initialHosts || [], hostsLoaded = Boolean(initialHosts);
      let state = { visible: false, ready: false, busy: false, error: false, text: '', seconds: 0,
        selectionError: null,
        choice: false, activeLabel: '', targetLabel: '', host: '', hosts, currentHost: null,
        currentModel: null, activeModel: null, loadingModel: null, phase: 'checking', availableModels: {}, modelCatalogs: {}, modelAvailable: false };
      const catalogs = new Map(), catalogEpochs = new Map();
      const labelFor = (model, host = current?.host) => catalogs.get(host?.id)?.models.find(row => row.id === model)?.name || model || '';
      const listeners = new Set();
      let disposed = false, current = null, generation = 0, preparing = false, startedAt = null;
      let observedAt = null, observedTarget = null, failure = null, selectionError = null;
      let abort, unsubscribe, polling, timerId, ownedBlock, explicitIntent, selectingTarget, lastStatus, action;
      let catalogRefreshAt = -Infinity, refreshingCatalogs = false;
      const availableModels = () => Object.fromEntries(hosts.map(host => [host.id,
        (catalogs.get(host.id)?.models || []).map(row => row.id).filter(model => directory.getSnapshot().groups?.some(group =>
          group.id === host.provider && group.models?.some(item => item.id === model)))]));
      const recordCatalog = (host, value) => {
        if (value?.gatewayId !== host.gatewayId) throw new Error('Host identity changed.');
        const revision = Number.isSafeInteger(value.catalogRevision) && value.catalogRevision >= 0 ? value.catalogRevision : 0;
        if (revision < (catalogs.get(host.id)?.revision || 0)) return;
        catalogs.set(host.id, { models: value.catalogReady === true && Array.isArray(value.models) ? value.models : [], ready: value.catalogReady === true, revision });
        if (current?.host.id === host.id && !catalogs.get(host.id).models.some(row => row.id === current.model)) {
          publish({ visible: true, ready: false, modelAvailable: false, choice: false,
            text: value.catalogReady === true ? `${hostTitle(host)}: ${labelFor(current.model)} is unavailable. Choose an available model, or restore it on the server.`
              : `${hostTitle(host)}: model availability could not be verified. Check the server connection and refresh.` });
        }
      };
      const setBlock = reason => {
        const existing = blocks.storeFor(sessionId).getSnapshot();
        if (reason) {
          if (existing && existing !== ownedBlock) return;
          ownedBlock = { reason }; blocks.set(sessionId, ownedBlock);
        } else if (ownedBlock) {
          if (existing === ownedBlock) blocks.set(sessionId, undefined);
          ownedBlock = undefined;
        }
      };
      const publish = next => {
        if (disposed) return;
        state = { ...state, hosts, availableModels: availableModels(),
          modelCatalogs: Object.fromEntries(hosts.map(host => [host.id, catalogs.get(host.id)?.models || []])), ...next, selectionError };
        setBlock(state.visible && !state.ready ? state.text : null);
        for (const listener of listeners) listener();
      };
      const cancelRequest = () => {
        generation++; abort?.abort(); abort = new AbortController(); preparing = false;
        failure = null; startedAt = null; observedAt = null; observedTarget = null;
      };
      const receive = (status, gen, catalogEpoch = catalogEpochs.get(current?.host.id) || 0) => {
        if (disposed || gen !== generation || !current || selectingTarget) return;
        lastStatus = status;
        if (status.applies === false) { publish({ visible: false, ready: false, busy: false, choice: false, text: '' }); return; }
        if (status.gatewayId !== current.host.gatewayId) throw new Error('Host identity changed.');
        if (catalogEpoch >= (catalogEpochs.get(current.host.id) || 0)) recordCatalog(current.host, status);
        const latestCatalog = catalogs.get(current.host.id) || { models: [], ready: false };
        // A delayed status may carry an older cached catalog than a refresh.
        status = { ...status, models: latestCatalog.models, catalogReady: latestCatalog.ready };
        lastStatus = status;
        const modelAvailable = availableModels()[current.host.id]?.includes(current.model) === true;
        const queued = status.activeRequests > 0 && status.desiredModel && status.desiredModel !== status.activeModel;
        const moving = transitioning(status) || Boolean(queued);
        const phase = queued ? 'waiting' : status.phase;
        const incoming = status.loadingModel || (moving ? status.desiredModel : preparing ? current.model : null);
        if (moving && (observedAt === null || observedTarget !== incoming)) { observedAt = now(); observedTarget = incoming; }
        if (!moving) { observedAt = null; observedTarget = null; }
        const ready = modelAvailable && !moving && !action && readyFor(status, current);
        if (ready) failure = null;
        const active = labelFor(status.activeModel);
        const choice = !ready && !preparing && !action && !moving && status.activeModel !== current.model && readyFor(status, { ...current, model: status.activeModel }) && Boolean(active);
        const target = labelFor(current.model);
        let text = ready ? `${target} ready on ${hostTitle(current.host)}` : `${hostTitle(current.host)}: checking ${target}…`;
        if (choice) text = `${hostTitle(current.host)} has ${active} loaded. This conversation uses ${target}.`;
        else if (!ready && moving) {
          const incomingLabel = labelFor(incoming);
          const action = { checking: 'checking readiness for', waiting: 'waiting to prepare',
            unloading: 'unloading the current model to prepare', releasing: 'releasing memory to prepare', loading: 'loading' }[phase];
          text = incomingLabel ? `${hostTitle(current.host)}: ${action} ${incomingLabel}. This conversation uses ${target}.` :
            `${hostTitle(current.host)}: a model switch is in progress. This conversation uses ${target}.`;
        }
        else if (!ready && status.error) text = `${hostTitle(current.host)}: model loading failed. You can retry.`;
        else if (!ready && !preparing) text = `${hostTitle(current.host)}: ${target} is not loaded.`;
        if (!modelAvailable && !moving) text = status.catalogReady === true
          ? `${hostTitle(current.host)}: ${target} is unavailable. Choose an available model, or restore it on the server.`
          : `${hostTitle(current.host)}: model availability could not be verified. Check the server connection and refresh.`;
        if (selectionError || failure) text = selectionError || failure;
        publish({ visible: true, ready, busy: !ready && (preparing || Boolean(action) || moving), error: Boolean(selectionError || failure || (!ready && status.error)),
          choice: Boolean(choice), activeLabel: active || '', targetLabel: target, host: hostTitle(current.host), text,
          currentHost: current.host, currentModel: current.model, activeModel: status.activeModel, modelAvailable,
          loadingModel: incoming, phase: phase || 'checking',
          seconds: !ready && (preparing || moving) ? Math.max(0, Math.floor((now() - (startedAt ?? observedAt ?? now())) / 1000)) : 0 });
      };
      const poll = async () => {
        if (disposed || !current || polling === generation || selectingTarget || (action && action.stage !== 'preparing')) return;
        const gen = generation, route = current, catalogEpoch = catalogEpochs.get(route.host.id) || 0; polling = gen;
        try { receive(await call('status', { hostId: route.host.id, model: route.model }, abort?.signal), gen, catalogEpoch); }
        catch {
          if (gen === generation && !disposed) {
            if (catalogEpoch >= (catalogEpochs.get(route.host.id) || 0)) catalogs.set(route.host.id,
              { models: [], ready: false, revision: catalogs.get(route.host.id)?.revision || 0 });
            publish({ visible: true, ready: false, busy: preparing, choice: false, modelAvailable: false,
            error: !preparing, phase: preparing ? 'checking' : 'error', text: `${hostTitle(route.host)}: status unavailable. Check the server connection.` });
          }
        } finally { if (polling === gen) polling = null; }
      };
      const prepare = async () => {
        if (!current || disposed || preparing || selectingTarget || (action && action.stage !== 'preparing') ||
            !availableModels()[current.host.id]?.includes(current.model)) return;
        const route = current, gen = ++generation, catalogEpoch = catalogEpochs.get(current.host.id) || 0;
        abort?.abort(); abort = new AbortController(); preparing = true; startedAt = now(); failure = null; selectionError = null;
        publish({ visible: true, ready: false, busy: true, choice: false, error: false, seconds: 0,
          currentHost: route.host, currentModel: route.model, targetLabel: labelFor(route.model, route.host), host: hostTitle(route.host),
          phase: 'checking', loadingModel: route.model, text: `${hostTitle(route.host)}: preparing ${labelFor(route.model, route.host)}…` });
        void poll();
        try { receive(await call('prepare', { hostId: route.host.id, model: route.model }, abort.signal), gen, catalogEpoch); }
        catch {
          if (gen === generation && !disposed) {
            failure = `${hostTitle(route.host)}: could not load ${labelFor(route.model, route.host)}. Check the server and retry.`;
            publish({ ready: false, busy: false, error: true, phase: 'error', text: failure });
          }
        } finally {
          if (gen === generation && !disposed) { preparing = false; startedAt = null; if (lastStatus) receive(lastStatus, gen); else publish({ busy: false }); void poll(); }
        }
      };
      const sync = (initial = false) => {
        const value = directory.getSnapshot();
        if (!hostsLoaded) {
          if (value.current?.provider?.startsWith('windows-')) publish({ visible: true, ready: false, busy: true, text: 'Checking configured model hosts…' });
          return;
        }
        const pending = routeOf(value.pending, hosts);
        if (value.status === 'selecting' && value.pending) {
          const target = routeKey(pending) || 'unmanaged';
          if (selectingTarget !== target) {
            selectionError = null;
            cancelRequest(); selectingTarget = target;
            if (action && (action.stage !== 'selecting' || action.key !== target)) action = null;
            explicitIntent = !initial && pending && action?.key !== target && target !== routeKey(current) ? target : null;
          }
          if (!pending) { publish({ visible: false, ready: false, busy: false, choice: false }); return; }
          publish({ visible: true, ready: false, busy: true, choice: false, error: false,
            phase: 'selecting', loadingModel: pending.model,
            text: `${hostTitle(pending.host)}: selecting ${labelFor(pending.model, pending.host)}…` });
          return;
        }
        const route = routeOf(value.current, hosts), key = routeKey(route);
        const wasSelecting = Boolean(selectingTarget); selectingTarget = null;
        if (value.status === 'error') explicitIntent = null;
        const changed = key !== routeKey(current);
        if (changed) {
          selectionError = null;
          if (action && (action.stage !== 'selecting' || action.key !== key)) action = null;
          cancelRequest(); current = route; lastStatus = null;
        }
        if (!route) {
          explicitIntent = null; action = null;
          publish({ visible: false, ready: false, busy: false, choice: false, error: false, text: '', seconds: 0, currentHost: null, currentModel: null }); return;
        }
        if (explicitIntent === key && value.status === 'ready') { explicitIntent = null; void prepare(); return; }
        if (explicitIntent && value.status === 'ready') {
          // The public directory emits ready with the old selection, then
          // projects the committed selection synchronously in the same turn.
          const intent = explicitIntent;
          Promise.resolve().then(() => { if (explicitIntent === intent && routeKey(current) !== intent) explicitIntent = null; });
        }
        if (changed || wasSelecting || initial) {
          publish({ visible: true, ready: false, busy: Boolean(action), choice: false, error: false, seconds: 0,
            currentHost: route.host, currentModel: route.model, targetLabel: labelFor(route.model, route.host), host: hostTitle(route.host),
            activeModel: null, activeLabel: '', phase: action ? 'selecting' : 'checking',
            text: `${hostTitle(route.host)}: checking loaded model…` });
          void poll();
        } else publish({});
      };
      const choose = async (model, hostId, adopt = false) => {
        if (disposed || !current || preparing || action || selectingTarget || state.busy || typeof model !== 'string') return false;
        const host = hosts.find(item => item.id === (hostId || current.host.id));
        if (!host || !availableModels()[host.id]?.includes(model)) return false;
        const target = { host, model }, before = routeKey(current);
        const own = { key: routeKey(target), stage: 'preflight' }; action = own; failure = null; selectionError = null;
        publish({ ready: false, busy: true, error: false, choice: false, phase: 'checking', loadingModel: model,
          text: `${hostTitle(host)}: checking ${labelFor(model, host)}…` });
        try {
          // This status request validates the exact provider/model binding in
          // the host process; registry membership alone is not authorization.
          const catalogEpoch = catalogEpochs.get(host.id) || 0;
          const fresh = await call('status', { hostId: host.id, model }, abort?.signal);
          if (disposed || action !== own || routeKey(current) !== before) return false;
          if (fresh?.applies === false || fresh?.gatewayId !== host.gatewayId) throw new Error('Host binding changed');
          if (catalogEpoch >= (catalogEpochs.get(host.id) || 0)) recordCatalog(host, fresh);
          if (!availableModels()[host.id]?.includes(model)) throw new Error('Model is no longer available');
          if (adopt && !readyFor(fresh, target)) throw new Error('Loaded model changed');
          if (own.key !== before) {
            own.stage = 'selecting';
            const efforts = catalogs.get(host.id)?.models.find(row => row.id === model)?.reasoningEfforts;
            const reasoningEffort = efforts && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].find(level => Object.hasOwn(efforts, level));
            const result = await select({ provider: host.provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
            if (disposed || action !== own) return false;
            if (result?.ok !== true) throw new Error('Selection rejected');
            if (routeKey(current) !== own.key || routeKey(routeOf(directory.getSnapshot().current, hosts)) !== own.key) return false;
          }
          if (adopt || readyFor(fresh, target)) {
            action = null; receive(fresh, generation); return true;
          }
          own.stage = 'preparing'; await prepare(); return !disposed && action === own && !failure;
        } catch {
          if (!disposed && action === own) {
            selectionError = adopt ? 'The loaded model changed or could not be selected. Refresh status and try again.' :
              'Could not select that model on this host. Refresh status and try again.';
            publish({ ready: false, busy: false, choice: false, error: true, phase: 'error', text: selectionError });
          }
          return false;
        } finally {
          if (action === own) { action = null; if (lastStatus) receive(lastStatus, generation); void poll(); }
        }
      };
      const refreshCatalogs = async (force = false) => {
        if (disposed || !hostsLoaded || refreshingCatalogs || (!force && now() - catalogRefreshAt < 30000)) return;
        refreshingCatalogs = true; catalogRefreshAt = now();
        try {
          await Promise.all(hosts.map(async host => {
            catalogEpochs.set(host.id, (catalogEpochs.get(host.id) || 0) + 1);
            try { const value = await call('catalog', { hostId: host.id, ...(force ? { refresh: true } : {}) }); if (!disposed) recordCatalog(host, value); }
            catch {
              if (!disposed) {
                const previous = catalogs.get(host.id);
                catalogs.set(host.id, { models: [], ready: false, revision: previous?.revision || 0 });
                if (current?.host.id === host.id) publish({ visible: true, ready: false, modelAvailable: false, choice: false,
                  text: `${hostTitle(host)}: model availability could not be verified. Check the server connection and refresh.` });
              }
            }
          }));
          if (!disposed) { publish({}); await poll(); }
        } finally { refreshingCatalogs = false; }
      };
      return {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        start() {
          unsubscribe = directory.subscribe(() => sync()); sync(true); timerId = timer(() => { void poll(); void refreshCatalogs(); }, interval);
          if (hostsLoaded) void refreshCatalogs();
          if (!hostsLoaded) void call('hosts', {}).then(value => { if (!disposed) { hosts = value.hosts || []; hostsLoaded = true; sync(true); void refreshCatalogs(); } })
            .catch(() => publish({ visible: Boolean(directory.getSnapshot().current?.provider?.startsWith('windows-')),
              ready: false, busy: false, error: true, text: 'Model host configuration is unavailable. Check the installation.' }));
        },
        loadConversation: prepare,
        selectInstalled: (model, hostId) => choose(model, hostId),
        useLoaded: () => state.choice ? choose(lastStatus?.activeModel, current?.host.id, true) : Promise.resolve(false),
        dismissSelectionError() { selectionError = null; if (lastStatus) receive(lastStatus, generation); else { publish({ error: false }); void poll(); } },
        poll,
        refreshCatalogs: () => refreshCatalogs(true),
        dispose() { disposed = true; action = null; generation++; abort?.abort(); unsubscribe?.(); clearTimer(timerId); setBlock(null); listeners.clear(); },
      };
    }

    function apply(ctx) {
      const call = async (operation, payload, signal) => {
        const result = await ctx.connection.rpc.call('/api', `windows-model-switch-client/${operation}`, payload, signal);
        if (!result.ok) throw new Error('The configured model host is unavailable.');
        return result.value;
      };
      function Status({ sessionId, modelDirectory }) {
        const [manage, setManage] = React.useState(false);
        const [open, setOpen] = React.useState(false);
        const [pickerHostId, setPickerHostId] = React.useState(null);
        const [hostList, setHostList] = React.useState([]);
        const panelId = React.useId();
        const controller = React.useMemo(() => createController({ directory: modelDirectory.store,
          select: selection => modelDirectory.select(selection), call, blocks: ctx.conversation.blocks, sessionId }), [modelDirectory, sessionId]);
        const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
        React.useEffect(() => { controller.start(); return () => controller.dispose(); }, [controller]);
        React.useEffect(() => { setPickerHostId(null); setOpen(false); setManage(false); }, [sessionId]);
        if (!state.visible) return null;
        const tone = state.error ? 'error' : state.ready ? 'ready' : state.busy ? 'loading' : state.choice ? 'choice' : 'checking';
        const stage = { selecting: 'Selecting', checking: 'Checking', waiting: 'Waiting', unloading: 'Unloading', releasing: 'Releasing memory', loading: 'Loading' }[state.phase] || 'Preparing';
        const badge = { ready: 'Ready', loading: stage, choice: 'Choose model', error: 'Needs attention', checking: 'Checking' }[tone];
        const button = (text, action, primary = false, props = {}) => React.createElement('button', {
          type: 'button', className: 'dsh-model-host-button', 'data-primary': primary || undefined,
          onClick: () => void action(), ...props,
        }, text);
        const manageHosts = async () => {
          setManage(value => !value);
          try { setHostList((await call('hosts', {})).hosts || []); } catch { setHostList([]); }
        };
        const hasActions = !state.ready && !state.busy;
        const expanded = open || hasActions || manage || Boolean(state.selectionError);
        const pickerHost = state.hosts.find(host => host.id === pickerHostId) || state.currentHost;
        const displayHost = state.host ? state.host.replace(/\s+\([^)]*\)$/, '') : 'Model host';
        const displayModel = state.busy && state.loadingModel
          ? state.modelCatalogs[state.currentHost?.id]?.find(model => model.id === state.loadingModel)?.name || state.loadingModel
          : state.targetLabel || state.activeLabel;
        return React.createElement('section', { className: 'dsh-model-host-card dsh-model-host-remote', 'data-expanded': expanded ? 'true' : undefined, 'aria-label': 'Model host controls' },
          React.createElement('style', null, `
            .dsh-model-host-card.dsh-model-host-remote{box-sizing:border-box;width:fit-content;max-width:min(calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px)),calc(var(--dsh-composer-card-max-width,952px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px)));margin:0 auto;min-width:0;flex:none;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:999px;background:var(--dsw-specific-input-major,#2c2c2e);color:var(--dsw-alias-label-secondary,#bfc0c5);font:11.5px/1.5 var(--dsw-font-family,system-ui);box-shadow:inset 0 1px 0 #ffffff05;position:relative;z-index:1}
            .dsh-model-host-card.dsh-model-host-remote[data-expanded]{width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));border-radius:20px;padding:10px 14px 12px}
            [data-slot="conversation.input.dock"]:has(+ [data-slot="conversation.composer.bar"] > div > [data-composer-card]:first-child) > .dsh-model-host-card.dsh-model-host-remote:last-child{margin-bottom:calc(0px - var(--dsh-composer-stack-gap,6px) - 3px)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-header{display:flex;align-items:center;gap:9px;min-width:0}
            .dsh-model-host-card.dsh-model-host-remote button.dsh-model-host-header{width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:12px}
            .dsh-model-host-card.dsh-model-host-remote button.dsh-model-host-header:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:4px}
            .dsh-model-host-card.dsh-model-host-remote[data-expanded] .dsh-model-host-header{flex-wrap:wrap}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-identity{display:flex;align-items:center;gap:7px;flex:0 1 auto;min-width:0}
            .dsh-model-host-card.dsh-model-host-remote[data-expanded] .dsh-model-host-identity{flex:1 1 140px}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-icon{display:flex;align-items:center;justify-content:center;flex:none;width:16px;height:18px;color:var(--dsw-alias-label-tertiary,#aaaab0)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-host{min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-ready-model{min-width:0;max-width:170px;flex:0 1 auto;padding-left:9px;border-left:1px solid var(--dsw-alias-border-l3,#ffffff29);color:var(--dsw-alias-label-primary,#eeeeef);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-badge{display:inline-flex;align-items:center;gap:5px;flex:none;line-height:18px;font-size:11px;font-weight:500;white-space:nowrap;color:var(--dsh-host-tone);--dsh-host-tone:var(--dsw-alias-label-secondary,#bfc0c5)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-badge[data-tone=ready]{--dsh-host-tone:var(--dsw-alias-state-success-primary,#4ed17e)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-badge[data-tone=loading]{--dsh-host-tone:var(--dsw-alias-state-business-primary,#5686fe)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-badge[data-tone=choice]{--dsh-host-tone:var(--dsw-alias-state-warn-primary,#f7ad31)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-badge[data-tone=error]{--dsh-host-tone:var(--dsw-alias-state-error-primary,#f87171)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-marker{width:6px;height:6px;border-radius:50%;background:var(--dsh-host-tone);flex:none}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-badge[data-tone=loading] .dsh-model-host-marker{width:10px;height:10px;box-sizing:border-box;background:transparent;border:1.5px solid color-mix(in srgb,var(--dsh-host-tone) 25%,transparent);border-top-color:var(--dsh-host-tone);animation:dsh-remote-host-spin 1s linear infinite}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-body{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l3,#ffffff29);color:var(--dsw-alias-label-secondary,#bfc0c5);overflow-wrap:anywhere}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-timer{font-variant-numeric:tabular-nums;font-size:11px;white-space:nowrap}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-button{box-sizing:border-box;min-height:32px;max-width:100%;border:1px solid var(--dsw-alias-border-l3,#ffffff29);border-radius:999px;padding:5px 12px;background:transparent;color:var(--dsw-alias-label-primary,#eeeeef);font:inherit;font-weight:500;text-align:center;overflow-wrap:anywhere;cursor:pointer}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-button[data-primary]{background:var(--dsw-alias-state-business-tertiary,#4176e61a);border-color:var(--dsw-alias-state-business-primary,#8eb6ff);color:var(--dsw-alias-state-business-primary,#8eb6ff);font-weight:600}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-button:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-button:disabled{cursor:default;opacity:.45}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#5686fe);outline-offset:2px}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-manage{display:grid;place-items:center;flex:none;min-height:24px;width:24px;height:24px;padding:0;color:var(--dsw-alias-label-tertiary,#aaaab0);border-color:transparent}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-details{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l3,#ffffff29);color:var(--dsw-alias-label-secondary,#bfc0c5);overflow-wrap:anywhere}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-list{display:grid;gap:8px;margin:0 0 10px;padding:0;list-style:none}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-list li{display:grid;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3,#ffffff29);border-radius:8px}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-list strong{color:var(--dsw-alias-label-primary,#eeeeef);font-weight:600}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-details p{margin:0}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-chevron{flex:none;margin-left:auto;transition:transform .15s ease}
            .dsh-model-host-card.dsh-model-host-remote[data-expanded] .dsh-model-host-chevron{transform:rotate(180deg)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-picker .dsh-model-host-button{border-radius:12px;text-align:left;display:grid;gap:2px}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-picker small{font-size:10px;font-weight:400;color:var(--dsw-alias-label-tertiary,#aaaab0)}
            .dsh-model-host-card.dsh-model-host-remote .dsh-model-host-select{max-width:100%;margin:6px 0;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,#ffffff29);background:var(--dsw-specific-input-major,#2c2c2e);color:inherit;font:inherit}
            @media(max-width:460px){.dsh-model-host-card.dsh-model-host-remote .dsh-model-host-header{flex-wrap:wrap}.dsh-model-host-card.dsh-model-host-remote .dsh-model-host-picker{grid-template-columns:1fr}}
            @keyframes dsh-remote-host-spin{to{transform:rotate(360deg)}}
            @media(prefers-reduced-motion:reduce){.dsh-model-host-card.dsh-model-host-remote .dsh-model-host-marker{animation:none!important}}
          `),
          React.createElement('button', { type: 'button', className: 'dsh-model-host-header',
            'aria-expanded': expanded, 'aria-controls': panelId, 'aria-label': `Model host: ${displayHost}. ${displayModel || ''}. ${badge}. Show model controls`,
            onClick: () => { setOpen(value => !value); setManage(false); } },
            React.createElement('div', { className: 'dsh-model-host-identity' },
              React.createElement('span', { className: 'dsh-model-host-icon', 'aria-hidden': true },
                React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  React.createElement('rect', { x: 3, y: 3, width: 18, height: 7, rx: 2 }),
                  React.createElement('rect', { x: 3, y: 14, width: 18, height: 7, rx: 2 }),
                  React.createElement('path', { d: 'M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6' }))),
              React.createElement('span', { className: 'dsh-model-host-host', title: state.host || 'Configured model server' }, displayHost)),
            displayModel ? React.createElement('span', { className: 'dsh-model-host-ready-model', title: displayModel }, displayModel) : null,
            React.createElement('span', { className: 'dsh-model-host-badge', 'data-tone': tone },
              React.createElement('span', { className: 'dsh-model-host-marker', 'aria-hidden': true }), badge),
            state.busy ? React.createElement('span', { className: 'dsh-model-host-timer', title: 'Elapsed since this preparation started or was first observed' }, `${state.seconds}s`) : null,
            React.createElement('svg', { className: 'dsh-model-host-chevron', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
              React.createElement('path', { d: 'm6 9 6 6 6-6' }))),
          React.createElement('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true,
            className: expanded ? 'dsh-model-host-body' : undefined,
            style: expanded ? undefined : { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' } }, state.text),
          React.createElement('div', { id: panelId, hidden: !expanded },
            hasActions || state.selectionError ? React.createElement('div', { className: 'dsh-model-host-actions' },
              state.selectionError ? button('Dismiss', controller.dismissSelectionError) : null,
              state.choice ? button(`Use loaded ${state.activeLabel}`, controller.useLoaded, true) : null,
              hasActions && state.modelAvailable ? button(`Load conversation ${state.targetLabel || 'model'}`, controller.loadConversation, !state.choice) : null,
              hasActions ? button('Refresh models', controller.refreshCatalogs) : null) : null,
            pickerHost ? React.createElement('div', { className: 'dsh-model-host-details' },
              state.hosts.length > 1 ? React.createElement('label', null, 'Model host ', React.createElement('select', {
                className: 'dsh-model-host-select', value: pickerHost.id, disabled: state.busy,
                onChange: event => setPickerHostId(event.target.value),
              }, state.hosts.map(host => React.createElement('option', { key: host.id, value: host.id }, host.label)))) : React.createElement('strong', null, pickerHost.label),
              React.createElement('p', null, pickerHost.url),
              React.createElement('p', null, `Provider: ${pickerHost.provider}`),
              React.createElement('p', null, `Current conversation on ${state.currentHost?.label || 'this host'}: ${state.targetLabel || 'Unknown'} · Loaded: ${state.activeLabel || 'Not ready'}`),
              React.createElement('div', { className: 'dsh-model-host-picker', 'aria-label': 'Models on selected host' }, (state.modelCatalogs[pickerHost.id] || []).map(({ id: model, name: label }) => {
                const available = state.availableModels[pickerHost.id]?.includes(model);
                const selected = pickerHost.id === state.currentHost?.id && model === state.currentModel;
                const loaded = pickerHost.id === state.currentHost?.id && model === state.activeModel && state.ready;
                return button(React.createElement(React.Fragment, null, React.createElement('span', null, label),
                  React.createElement('small', null, !available ? 'Unavailable in provider' : loaded ? 'Loaded · selected' : selected ? 'Conversation model · click to load' : 'Switch conversation and load')),
                () => controller.selectInstalled(model, pickerHost.id), selected,
                { key: model, disabled: state.busy || !available, 'aria-pressed': selected, title: model });
              })),
              !(state.modelCatalogs[pickerHost.id]?.length) ? React.createElement('p', null, 'No available models reported by this host. Check the server, then refresh models.') : null,
              React.createElement('div', { className: 'dsh-model-host-actions' }, button('Manage hosts', manageHosts, false, { 'aria-expanded': manage }))) : null,
          manage ? React.createElement('div', { className: 'dsh-model-host-details', 'aria-label': 'Configured model hosts' },
            hostList.length ? React.createElement('ul', { className: 'dsh-model-host-list' }, hostList.map(host =>
              React.createElement('li', { key: host.id }, React.createElement('strong', null, host.label),
                React.createElement('span', null, host.url), React.createElement('span', null, `Provider: ${host.provider}`)))) :
              React.createElement('p', null, 'No host details available. Close and reopen Manage hosts to refresh.'),
            React.createElement('p', null, 'To add or edit a host, quit Harness and run the Mac installer with --host-id NAME --server URL --host-label LABEL. It verifies the server and preserves other hosts. Keys are entered privately in Terminal.')) : null));
      }
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'windows-model-switch-client', order: -20,
        inject: sessionId => ({ sessionId, modelDirectory: ctx.modelDirectories.directoryFor(sessionId) }),
      }, Status));
    }
    return { apply, inject: ['slots', 'modelDirectories', 'conversation', 'connection', 'sessions'], createController, routeOf, readyFor };
  },
});
