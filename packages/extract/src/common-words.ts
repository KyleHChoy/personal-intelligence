// Words too common to say which project a message is in. A project's head word on this list counts
// for nothing, and the message must write the whole name or sit on an anchored thread. A fixed list of
// everyday English nouns and adjectives of four letters or more, held to what a project's name might
// end in. A word it misses still has to be in the owner's own text, and the model to file a fact under
// the project. Extended by a commit.
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  `
  access account accounting action activity admin advice agency agent agents analysis analytics answer
  application apps area areas article assessment asset assets assistant audit automation award
  backend bank banking base basics benefit benefits best bill blog board body book books brand brief budget
  building business buying campaign capital card cards care career careers case center centre chain challenge
  change changes channel chapter check claim class classes client clients cloud club coach coaching code
  college community companies compliance computer conference consulting contact contacts content contract
  contracts control core cost costs credit culture customer customers
  dashboard data database deal deals debt decision decisions degree demo design designs desk detail details
  development device devices digital direction director discussion doctor document documents draft
  economics economy education effort email emails employee employees energy engine engineering enterprise
  equity estate event events exam exams experience experiment expert export
  family feature features feedback field file files film final finance financial firm fitness focus food form
  forms founder founders framework fund funding funds future game games general goal goals grant grants graph
  group groups growth guide health help hiring history home house housing idea ideas identity image
  impact import income index industry information infrastructure initiative insight insights insurance
  intelligence interface internal internship investing investment investments issue issues item items
  journal knowledge language launch lead leads learning legal letter level life list loan loans
  machine mail main management manager manual market marketing markets material math matter media member
  members memo message messages method metrics mobile model models money music
  name names needs network networks news note object offer office online operations opportunity option options
  order orders organization outreach overview owner page pages paper papers partner partners partnership
  party payment payments people performance person personal phone photo pipeline place platform policy
  portfolio post practice price pricing process product products profile program progress proposal proposals
  public purchase quality question questions rate reading real record records recruiting reference
  relations report reports request requests research resource resources result results resume retail
  revenue risk road role roles rules safety sale sales savings scale schedule school science score search
  season security segment seminar series server service services session sessions setup share shop site skill
  skills social software solution solutions source space speech staff stage standard start state statement
  status stock store story strategy student students studio study style subject summary supply support survey
  system systems talent talk talks target task tasks teaching tech technology test testing tests text
  thesis thing things ticket time tool tools topic tour tracker tracking trade trading training transfer travel
  trial trip trust unit university user users value vendor venture ventures video view vision web website
  week wiki world writing year
`
    .trim()
    .split(/\s+/),
);
