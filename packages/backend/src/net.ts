import dgram from 'node:dgram';
import net from 'node:net';

/** UDP ports (Bedrock, Hytale): free when we can bind it ourselves for a moment. */
export function isUdpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      sock.close();
      resolve(false);
    });
    sock.bind(port, () => sock.close(() => resolve(true)));
  });
}

export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}
