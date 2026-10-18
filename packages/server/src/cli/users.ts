/**
 * Account administration from the server's console (for the first administrator, or when locked out).
 *
 *   tsx src/cli/users.ts list
 *   tsx src/cli/users.ts invite <userId> [--admin]     one-time password, changed on first sign-in
 *   tsx src/cli/users.ts reset <userId>                new one-time password, signs the user out
 *   tsx src/cli/users.ts admin <userId> on|off
 */
import { findUser, inviteUser, listUsers, resetPassword, setAdmin } from '../storage';

const [cmd, name, arg] = process.argv.slice(2);
const user = () => {
  const u = name && findUser(name);
  if (!u) throw new Error(`No user "${name ?? ''}".`);
  return u;
};
switch (cmd) {
  case 'list':
    for (const u of listUsers()) console.log(`${u.username.padEnd(24)} ${u.isAdmin ? 'admin ' : 'normal'} ${u.mustChangePassword ? '(must change password)' : ''}`);
    break;
  case 'invite': {
    const { user: u, password } = inviteUser(name ?? '', process.argv.includes('--admin'));
    console.log(`Created ${u.isAdmin ? 'administrator' : 'user'} "${u.username}" with one-time password: ${password}`);
    break;
  }
  case 'reset':
    console.log(`New one-time password for "${user().username}": ${resetPassword(user().id)}`);
    break;
  case 'admin':
    setAdmin(user().id, arg === 'on');
    console.log(`"${user().username}" is now ${arg === 'on' ? 'an administrator' : 'a normal user'}.`);
    break;
  default:
    console.log('usage: users list | invite <userId> [--admin] | reset <userId> | admin <userId> on|off');
}
