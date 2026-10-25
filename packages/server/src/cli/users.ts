/**
 * Account administration from the server's console (for the first administrator, or when locked out).
 *
 *   tsx src/cli/users.ts list
 *   tsx src/cli/users.ts invite <name> [--admin]       a new account for <name> (who it is for): prints its invite link
 *   tsx src/cli/users.ts reset <username or id>        invited again with a new code (password and passkeys removed)
 *   tsx src/cli/users.ts admin <username or id> on|off
 *
 * An account not set up yet has no user name: use its id (from list), e.g. when its invite ran out.
 *
 * The invite link is the site's address followed by /#/invite/<code>.
 */
import { createUser, findUser, getUser, listUsers, resetUser, setAdmin } from '../storage';

const [cmd, name, arg] = process.argv.slice(2);
const user = () => {
  const u = name && (findUser(name) ?? getUser(name));
  if (!u) throw new Error(`No user "${name ?? ''}".`);
  return u;
};
const link = (code: string | null) => `invite link: <this site>/#/invite/${code}`;
switch (cmd) {
  case 'list':
    for (const u of listUsers()) console.log(`${u.id.padEnd(16)} ${(u.username ?? '(not chosen yet)').padEnd(24)} ${u.displayName.padEnd(24)} ${u.isAdmin ? 'admin ' : 'player'} ${u.status}${u.status === 'invited' ? ` (code ${u.inviteCode})` : ''}`);
    break;
  case 'invite': {
    const u = createUser({ displayName: name ?? '', isAdmin: process.argv.includes('--admin') });
    console.log(`Invited ${u.isAdmin ? 'administrator' : 'player'} "${u.displayName}" (they choose their user name); ${link(u.inviteCode)}`);
    break;
  }
  case 'reset': {
    const u = resetUser(user().id);
    console.log(`"${u.username ?? u.displayName}" must be set up again; ${link(u.inviteCode)}`);
    break;
  }
  case 'admin':
    setAdmin(user().id, arg === 'on');
    console.log(`"${user().username ?? user().displayName}" is now ${arg === 'on' ? 'an administrator' : 'a player'}.`);
    break;
  default:
    console.log('usage: users list | invite <name> [--admin] | reset <username or id> | admin <username or id> on|off');
}
