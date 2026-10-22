import { serverTypeInfo, type ServerInfo } from '@srvmc/shared';
import { Icon } from './Icon.tsx';
import { useToast } from './Overlays.tsx';
import { t } from '@srvmc/shared';

export function ServerTile({ server, large }: { server: ServerInfo; large?: boolean }) {
  return (
    <div className={`tile${large ? ' lg' : ''}`} style={{ background: serverTypeInfo(server.type).color }} aria-hidden="true">
      {server.name.charAt(0).toUpperCase()}
    </div>
  );
}

export function serverAddress(server: ServerInfo): string {
  return server.port === 25565 ? 'localhost' : `localhost:${server.port}`;
}

export function AddressBox({ server }: { server: ServerInfo }) {
  const toast = useToast();
  const address = serverAddress(server);
  return (
    <div className="address">
      <span>{address}</span>
      <button
        type="button"
        className="btn icon sm"
        aria-label={t('Copy address')}
        onClick={() => {
          void navigator.clipboard.writeText(address);
          toast('ok', t('Address copied'), address);
        }}
      >
        <Icon name="copy" size={16} />
      </button>
    </div>
  );
}
