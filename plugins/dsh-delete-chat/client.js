/* Public Harness extension slots. Every request uses the selected Harness host. */
window.__ModuleLoader__.load({
  id: 'dsh-delete-chat',
  factory(require) {
    const React = require('react');
    const { Modal, Button, MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    function createDialogController({ call, refresh }) {
      let state = null, generation = 0, abort;
      const listeners = new Set();
      const publish = value => { state = value; for (const listener of listeners) listener(); };
      const controller = {
        getSnapshot: () => state,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        async open(sessionId, displayTitle) {
          if (state?.busy) return;
          const current = ++generation;
          abort?.abort(); abort = new AbortController();
          publish({ sessionId, displayTitle: displayTitle || 'Untitled chat', checking: true, busy: false });
          try {
            const preview = await call('preview', { sessionId }, abort.signal);
            if (current === generation) publish({ ...state, checking: false, preview });
          } catch (error) {
            if (current === generation) publish({ ...state, checking: false, error: error.message || 'This host could not verify deletion.' });
          }
        },
        close() { if (state?.busy) return; ++generation; abort?.abort(); publish(null); },
        async confirm() {
          if (!state?.preview?.eligible || state.busy) return;
          const request = state, current = generation;
          publish({ ...state, busy: true, error: null });
          try {
            const result = await call('delete', { sessionId: request.sessionId, token: request.preview.token,
              confirmation: 'delete-archived-chat' }, abort.signal);
            // Refresh the real baseline, not just an optimistic local row removal.
            await refresh().catch(() => {});
            if (current === generation) publish({ ...request, busy: false, result, preview: null });
          } catch (error) {
            await refresh().catch(() => {});
            if (current === generation) publish({ ...request, busy: false, preview: null,
              error: error.message || 'The result could not be confirmed. Refresh before trying again.' });
          }
        },
        reset() { ++generation; abort?.abort(); publish(null); },
      };
      return controller;
    }

    function TrashIcon({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7' }));
    }

    function apply(ctx) {
      const controller = createDialogController({
        async call(operation, payload, signal) {
          const result = await ctx.connection.rpc.call('/api', `archived-chat-delete/${operation}`, payload, signal);
          if (!result.ok) throw new Error(result.error?.message || 'This Harness host does not support archived-chat deletion.');
          return result.value;
        },
        refresh: () => ctx.sessions.refresh(),
      });
      const subscribe = listener => ctx.workspaces.list.subscribe(listener);
      const snapshot = () => ctx.workspaces.list.getSnapshot();
      const useArchived = id => React.useSyncExternalStore(subscribe, snapshot, snapshot).archivedSessionIds.includes(id);

      function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
        const archived = useArchived(sessionId);
        const [, setOpen] = useMenuOpenState();
        if (!archived) return null;
        return h(MenuItemButton, { separatorBefore: true, icon: h(TrashIcon),
          onSelect: () => { setOpen(false); void controller.open(sessionId, displayTitle); } }, 'Delete archived chat…');
      }

      function DeleteRowButton({ sessionId, displayTitle }) {
        const archived = useArchived(sessionId);
        if (!archived) return null;
        return h('button', { type: 'button', title: 'Delete archived chat', 'aria-label': 'Delete archived chat',
          style: { display: 'inline-grid', placeItems: 'center', width: 24, height: 24, padding: 0,
            border: 0, borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-tertiary,#96969d)', cursor: 'pointer' },
          onClick: event => { event.stopPropagation(); void controller.open(sessionId, displayTitle); } }, h(TrashIcon));
      }

      function DeleteDialog() {
        const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
        if (!state) return null;
        const success = state.result?.deleted === true;
        const close = () => controller.close();
        return h(Modal, {
          open: true, onClose: close, closeLabel: 'Close', title: success ? 'Archived chat deleted' : 'Delete archived chat?',
          description: state.displayTitle,
          footer: h(React.Fragment, null,
            h(Button, { variant: 'outline', onClick: close, disabled: state.busy }, success ? 'Done' : 'Cancel'),
            !success && h(Button, { variant: 'outline', disabled: state.busy || !state.preview?.eligible,
              onClick: () => { void controller.confirm(); },
              style: { color: 'var(--dsw-alias-state-error-primary,#f68d8d)' } }, state.busy ? 'Deleting…' : 'Delete chat')),
        }, h('div', { style: { display: 'grid', gap: 12, fontSize: 13, lineHeight: 1.6, overflowWrap: 'anywhere' } },
          state.preview?.hostLabel && h('div', { style: { color: 'var(--dsw-alias-label-tertiary,#96969d)' } }, `Harness host: ${state.preview.hostLabel}`),
          state.checking && h('p', { role: 'status' }, 'Checking archive status, stored history, and linked conversations…'),
          state.preview && h('p', { role: state.preview.eligible ? undefined : 'status' }, state.preview.message),
          state.busy && h('p', { role: 'status', 'aria-live': 'polite' }, 'Saving a recovery backup and removing the chat. Keep this window open.'),
          state.error && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary,#f68d8d)' } }, state.error),
          success && h(React.Fragment, null,
            h('p', { role: 'status' }, 'Removed from Harness. Project files and shared attachments were kept.'),
            h('div', null, h('strong', null, 'Recovery backup'), h('div', null, state.result.backupPath)),
            h('p', { style: { color: 'var(--dsw-alias-label-tertiary,#96969d)' } }, 'This removes the chat from the app; it does not securely erase the backup.'))));
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: '@local/archived-chat-delete', order: 500,
      }, DeleteMenuItem));
      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action', id: '@local/archived-chat-delete', order: 300,
      }, DeleteRowButton));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: '@local/archived-chat-delete.dialog', order: 500,
      }, DeleteDialog));
      ctx.on('connection/reset', () => controller.reset());
      ctx.effect(() => () => controller.reset(), 'archived-chat-delete dialog cleanup');
    }
    return { apply, inject: ['slots', 'workspaces', 'sessions', 'connection'], createDialogController };
  },
});
