/** Genre-appropriate wording for NPCs the generator has to fill in itself (no LLM, or a required role missing). */
import type { NpcRole } from '@gd/shared';
import type { Genre } from './genres';

export type NpcSlot = 'innkeeper' | 'trader' | 'weapons' | 'trainer' | 'guard' | 'alchemist' | 'local' | 'armor' | 'companion' | 'worker' | 'curios' | 'tinker' | 'warden' | 'gossip';

export interface NpcFlavor {
  titles: Record<NpcSlot, string>;
  greetings: Partial<Record<NpcRole, string[]>> & { commoner: string[] };
  barks: string[];
  shortBarks: string[];
  clothes: string[];
  builds: string[];
  /** How long someone has lived here ({town} is replaced). */
  history: string[];
  rumor: string;
}

const FANTASY: NpcFlavor = {
  titles: { innkeeper: 'Innkeeper', trader: 'Trader', weapons: 'Smith', trainer: 'Weapons Master', guard: 'Guard', alchemist: 'Alchemist', local: 'Local', armor: 'Armorer', companion: 'Wandering Adventurer', worker: 'Farmer', curios: 'Curio Dealer', tinker: 'Tinker', warden: 'Gate Warden', gossip: 'Gossip' },
  greetings: {
    innkeeper: ['Come in, come in! A bed and a hot meal won’t cost you much.', 'Rooms upstairs, ale down here. What’ll it be?'],
    merchant: ['Looking to buy? Everything here is honest work.', 'Coin talks. What are you after?'],
    trainer: ['You have the look of someone who could learn a thing or two.', 'Skill is earned, not given. Want to earn some?'],
    guard: ['Keep your weapons sheathed in town.', 'Move along, traveler. Unless you have business.'],
    companion: ['Heading out? Could use the company, and you look like you could use a sword arm.', 'The road is lonely. I’m not picky about whose side I’m on, as long as it’s the winning one.'],
    commoner: ['Welcome to {town}. Mind the mud.', 'Strange times. Strange times.'],
    crafter: ['If it’s broken, I can fix it. If it isn’t, I can improve it.'],
  },
  barks: ['Fine weather, if it lasts.', 'Heard wolves again last night.', 'Prices keep going up.', 'Did you see those lights?'],
  shortBarks: ['Watch yourself out there.', 'Busy day.', 'Hm.'],
  clothes: ['simple work clothes', 'a stained apron', 'well-kept finery', 'travel-worn leathers'],
  builds: ['weathered', 'young', 'elderly', 'stout', 'lanky'],
  history: ['all their life', 'for a few uneasy years', 'since the last war'],
  rumor: 'Things have been odd around {town} lately.',
};

const SCIFI: NpcFlavor = {
  titles: { innkeeper: 'Bunkhouse Steward', trader: 'Supply Broker', weapons: 'Armsdealer', trainer: 'Combat Instructor', guard: 'Security Officer', alchemist: 'Med-Chemist', local: 'Station Hand', armor: 'Hardsuit Fitter', companion: 'Freelance Operative', worker: 'Hydroponics Tech', curios: 'Salvage Collector', tinker: 'Fabricator Tech', warden: 'Dock Controller', gossip: 'Comms Chatterbox' },
  greetings: {
    innkeeper: ['Bunks are clean, the recycler mostly works. Need a rack for the night?', 'Hot ration, cold bunk, fair rate. Interested?'],
    merchant: ['Credits up front, no refunds on salvage.', 'Everything on the rack is certified. Mostly.'],
    trainer: ['Your stance is sloppy. I can fix that, for a fee.', 'Sims are free. Real training costs. Which do you want?'],
    guard: ['Keep your weapon locked while on deck.', 'ID check. ...Fine. Move along.'],
    companion: ['Heading into the dark sections? I’ve got a rifle and nothing better to do.', 'You look like someone who pays. I’m someone who shoots.'],
    commoner: ['Welcome to {town}. Air’s recycled, but it’s free.', 'Another shift, another alarm.'],
    crafter: ['Bring me scrap, I’ll bring you something that works.'],
  },
  barks: ['Life support hiccuped again last cycle.', 'Saw a ship dock with no transponder.', 'Ration prices went up again.', 'Did you hear that noise in the vents?'],
  shortBarks: ['Stay frosty.', 'Long shift.', 'Hm.'],
  clothes: ['a grease-stained jumpsuit', 'a patched flight jacket', 'a crisp station uniform', 'scuffed work armor'],
  builds: ['weathered', 'young', 'grizzled', 'stocky', 'wiry'],
  history: ['since they were born on-station', 'for three hard rotations', 'since the last evacuation'],
  rumor: 'Systems around {town} have been glitching lately.',
};

const MODERN: NpcFlavor = {
  titles: { innkeeper: 'Motel Manager', trader: 'Corner Store Owner', weapons: 'Pawnshop Dealer', trainer: 'Self-Defense Coach', guard: 'Security Guard', alchemist: 'Pharmacist', local: 'Regular', armor: 'Outfitter', companion: 'Drifter', worker: 'Maintenance Worker', curios: 'Antique Dealer', tinker: 'Repair Guy', warden: 'Front Desk Officer', gossip: 'Neighborhood Gossip' },
  greetings: {
    innkeeper: ['Room’s forty a night. Ice machine’s broken.', 'Need a room? Checkout’s at eleven.'],
    merchant: ['Cash or card? Card machine’s down, so cash.', 'Looking for something specific?'],
    trainer: ['You won’t last five minutes out there. Let me show you a few things.', 'First lesson: don’t get hit. Second lesson costs money.'],
    guard: ['Badge? No? Then keep walking.', 'No loitering, pal.'],
    companion: ['You look like you’re heading somewhere interesting. Mind if I tag along?', 'I could use something to do. And you could use backup.'],
    commoner: ['Welcome to {town}. Don’t park there.', 'Weird week. Really weird week.'],
    crafter: ['If it plugs in, I can fix it. If it doesn’t, I can probably still fix it.'],
  },
  barks: ['Power flickered again last night.', 'Heard sirens till three a.m.', 'Gas went up again.', 'Did you see that guy in the parking lot?'],
  shortBarks: ['Take care.', 'Long day.', 'Hm.'],
  clothes: ['a faded hoodie', 'a work uniform with a name tag', 'a sharp business suit', 'worn jeans and a denim jacket'],
  builds: ['tired', 'young', 'older', 'heavyset', 'lanky'],
  history: ['their whole life', 'for a couple of rough years', 'since the plant closed'],
  rumor: 'Things have been off around {town} lately.',
};

const COZY: NpcFlavor = {
  titles: { innkeeper: 'Tea House Keeper', trader: 'Market Stall Keeper', weapons: 'Toolmaker', trainer: 'Wise Elder', guard: 'Village Watch', alchemist: 'Herbalist', local: 'Neighbor', armor: 'Tailor', companion: 'Wandering Helper', worker: 'Gardener', curios: 'Trinket Collector', tinker: 'Clockmaker', warden: 'Bridge Keeper', gossip: 'Chatty Neighbor' },
  greetings: {
    innkeeper: ['Come in out of the cold! Kettle’s just boiled.', 'A cozy bed and a warm scone. Will you stay?'],
    merchant: ['Fresh today! Have a look, take your time.', 'Oh, a visitor! Anything catch your eye?'],
    trainer: ['Patience first, then the rest follows. Shall we begin?', 'Every little creature can learn something new.'],
    guard: ['All’s well on my watch, I hope.', 'Mind the flower beds, please.'],
    companion: ['Off on an adventure? Could I come? I can carry snacks.', 'It’s more fun with a friend, don’t you think?'],
    commoner: ['Welcome to {town}! Lovely day for it.', 'Have you tried the honey cakes yet?'],
    crafter: ['Bring it here, dear, I’ll mend it good as new.'],
  },
  barks: ['The blackberries are nearly ripe.', 'Heard an owl singing last night.', 'Someone’s baking, smell that?', 'The stream’s running high this week.'],
  shortBarks: ['Mind how you go.', 'Busy, busy.', 'Hm-hm.'],
  clothes: ['a patched knitted jumper', 'a flour-dusted apron', 'a neat little waistcoat', 'a well-loved traveling cloak'],
  builds: ['round', 'young', 'old', 'plump', 'nimble'],
  history: ['all their life', 'since the big flood', 'since they were a little one'],
  rumor: 'Something funny has been going on around {town}.',
};

const HORROR: NpcFlavor = {
  ...FANTASY,
  titles: { ...FANTASY.titles, innkeeper: 'Publican', trader: 'Grocer', weapons: 'Gunsmith', trainer: 'Retired Constable', guard: 'Watchman', alchemist: 'Apothecary', worker: 'Fisherman', curios: 'Antiquarian', companion: 'Haunted Wanderer', gossip: 'Parish Busybody' },
  greetings: {
    ...FANTASY.greetings,
    innkeeper: ['Rooms are dry, mostly. Lock your door tonight.', 'A drink, stranger? You look like you need one.'],
    guard: ['Best be indoors before dark.', 'We don’t get many visitors. Why are you here?'],
    commoner: ['Welcome to {town}. Don’t go near the water.', 'You shouldn’t have come here.'],
  },
  barks: ['The bells rang again at midnight.', 'Old Mrs. Hale hasn’t been seen in days.', 'Fog’s thicker than it should be.', 'Did you hear singing from the shore?'],
  shortBarks: ['Keep the lamps lit.', 'Don’t linger.', '...'],
  clothes: ['a damp wool coat', 'a fisherman’s oilskin', 'threadbare Sunday best', 'a mourning shawl'],
  builds: ['gaunt', 'young', 'elderly', 'hunched', 'pale'],
  history: ['all their life', 'since the drownings', 'longer than they care to say'],
  rumor: 'People have been going missing around {town}.',
};

const WHIMSY: NpcFlavor = {
  ...COZY,
  titles: { ...COZY.titles, innkeeper: 'Upside-Down Innkeeper', trader: 'Button Merchant', weapons: 'Hatpin Smith', trainer: 'Riddle Master', guard: 'Card Sentry', curios: 'Collector of Lost Things', gossip: 'Talking Teapot' },
  barks: ['Tuesday came twice this week.', 'The roses were painted again last night.', 'My hat says it’s teatime.', 'Have you seen my left shadow?'],
  shortBarks: ['Curiouser.', 'Late, late!', 'Hm?'],
};

export const NPC_FLAVOR: Record<Genre, NpcFlavor> = { fantasy: FANTASY, scifi: SCIFI, modern: MODERN, cozy: COZY, horror: HORROR, whimsy: WHIMSY };
