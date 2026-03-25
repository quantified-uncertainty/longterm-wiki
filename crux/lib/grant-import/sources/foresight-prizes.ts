/**
 * Foresight Institute — Feynman Prize in Nanotechnology & Norm Hardy Prize.
 *
 * Feynman Prize ($5,000 Theory + $5,000 Experiment + $1,000 Student):
 *   Named after Richard Feynman's 1959 lecture "There's Plenty of Room at the
 *   Bottom." Awarded since 1993 for work advancing molecular manufacturing.
 *   From 1993-1995 a single prize; from 1997 onward split into Theory and
 *   Experiment categories. A Distinguished Student Award ($1,000) has been
 *   awarded intermittently since 2003.
 *
 * Norm Hardy Prize ($10,000):
 *   Annual prize for advances in usable security, honoring computer scientist
 *   Norm Hardy. Sponsored by Agoric and Protocol Labs. First awarded in 2023.
 *
 * Sources:
 *   - https://foresight.org/prizes/feynman-prizes/
 *   - https://foresight.org/foresight-feynman-prizes/ (full winner list)
 *   - https://foresight.org/prizes/norm-hardy-prize/
 *   - Individual press releases and university announcements (see sourceUrl per award)
 */

import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";
import { generateId } from "../id.ts";

// ---------------------------------------------------------------------------
// Pre-computed program IDs — must match seeds in import-funding-programs.ts
// ---------------------------------------------------------------------------

const NORM_HARDY_PROGRAM_ID = generateId("prog|foresight|norm-hardy-prize");
const FEYNMAN_THEORY_PROGRAM_ID = generateId("prog|foresight|feynman-prize-theory");
const FEYNMAN_EXPERIMENT_PROGRAM_ID = generateId("prog|foresight|feynman-prize-experiment");
const FEYNMAN_STUDENT_PROGRAM_ID = generateId("prog|foresight|feynman-student-award");

// ---------------------------------------------------------------------------
// Shared award interface
// ---------------------------------------------------------------------------

interface PrizeAward {
  year: number;
  /** Display name of the recipient (person or team) */
  recipient: string;
  /** What the prize was awarded for */
  achievement: string;
  /** Institutional affiliation(s) at time of award */
  institution: string;
  /** Announcement date (YYYY-MM) */
  date: string;
  /** Source URL for the announcement */
  sourceUrl: string;
}

// ---------------------------------------------------------------------------
// Norm Hardy Prize data
// ---------------------------------------------------------------------------

const NORM_HARDY_AWARDS: PrizeAward[] = [
  {
    year: 2023,
    recipient: "Covid Watch",
    achievement:
      "Designed and prototyped the first decentralized digital contact tracing system during the COVID-19 pandemic. The design was shared with Apple in March 2020; Apple and Google subsequently launched the Exposure Notification system reaching ~100 million users. Founded by Tina White, James Petrie, Rhys Fenwick, and Zsombor Szabo.",
    institution: "Covid Watch (nonprofit)",
    date: "2024-02",
    sourceUrl:
      "https://www.prweb.com/releases/2023-norm-hardy-prize-awarded-by-foresight-institute-for-advances-in-usable-security-302061691.html",
  },
  {
    year: 2024,
    recipient: "Dr. Alisa Frik, Dr. Serge Egelman, Conor Gilsenan, Prof. Eyal Peer",
    achievement:
      'Research on "Protect Me Tomorrow" — commitment nudges and reminders that encourage users to take security actions like changing compromised passwords. Demonstrated that personalized cybersecurity nudges significantly boost user behavior change, increasing effectiveness up to four times compared to generic approaches.',
    institution:
      "International Computer Science Institute (ICSI) / UC Berkeley / Hebrew University of Jerusalem",
    date: "2024-12",
    sourceUrl:
      "https://www.prweb.com/releases/2024-norm-hardy-prize-awarded-by-foresight-institute-for-advances-in-usable-security-302344249.html",
  },
  {
    year: 2025,
    recipient: "Dr. Pardis Emami-Naeini, Dr. Lorrie Faith Cranor, Dr. Yuvraj Agarwal",
    achievement:
      "Developed a layered cybersecurity label for smart home devices highlighting security updates, authentication, and data handling. Research demonstrated that clear security information leads consumers to make more secure choices. Work directly shaped the U.S. Cyber Trust Mark labeling initiative for connected devices.",
    institution: "Duke University / Carnegie Mellon University",
    date: "2026-01",
    sourceUrl:
      "https://www.cylab.cmu.edu/news/2026/02/06-norm-hardy-prize.html",
  },
];

// ---------------------------------------------------------------------------
// Feynman Prize data — Theory category
// ---------------------------------------------------------------------------

interface FeynmanAward extends PrizeAward {
  category: "theory" | "experiment" | "student";
}

const FEYNMAN_AWARDS: FeynmanAward[] = [
  // ============================================================
  // 1993 — Single prize (no Theory/Experiment split yet)
  // ============================================================
  {
    year: 1993,
    category: "theory",
    recipient: "Charles Musgrave",
    achievement:
      "Modeling of a hydrogen abstraction tool useful in nanotechnology, conducted at the Materials & Molecular Simulation Center under William A. Goddard III.",
    institution: "California Institute of Technology",
    date: "1993-11",
    sourceUrl: "https://foresight.org/foresight-update-parent/foresight-update-17/",
  },

  // ============================================================
  // 1995 — Single prize (biennial)
  // ============================================================
  {
    year: 1995,
    category: "theory",
    recipient: "Nadrian C. Seeman",
    achievement:
      "Pioneering work in DNA nanotechnology, developing techniques for constructing complex nanoscale structures from DNA molecules.",
    institution: "New York University",
    date: "1995-11",
    sourceUrl: "https://www.zyvex.com/nanotech/feynmanPrize.html",
  },

  // ============================================================
  // 1997 — First year with Theory/Experiment split
  // ============================================================
  {
    year: 1997,
    category: "theory",
    recipient: "Charles Bauschlicher, Stephen Barnard, Creon Levit, Glenn Deardorff, Al Globus, Jie Han, Richard Jaffe, Alessandra Ricca, Marzio Rosi, Deepak Srivastava, H. Thuemmel",
    achievement:
      "Computational nanotechnology research, including molecular dynamics simulations of carbon nanotube-based gears, bearings, and other molecular machine components.",
    institution: "NASA Ames Research Center / MRJ Technology Solutions",
    date: "1997-11",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 1997,
    category: "experiment",
    recipient: "James K. Gimzewski, Reto Schlittler, Christian Joachim, Phil Collins",
    achievement:
      "Using scanning probe microscopes to manipulate individual molecules, including operating a single-molecule rotor and demonstrating mechanical amplification at the molecular level.",
    institution: "IBM Zurich Research Laboratory / CEMES-CNRS (France)",
    date: "1997-11",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 1998
  // ============================================================
  {
    year: 1998,
    category: "theory",
    recipient: "Ralph C. Merkle, Stephen Walch",
    achievement:
      "Computational modeling of molecular tools for atomically-precise chemical reactions, advancing the theoretical foundations of mechanosynthesis.",
    institution: "Xerox Palo Alto Research Center / ELORET at NASA Ames Research Center",
    date: "1998-11",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 1998,
    category: "experiment",
    recipient: "M. Reza Ghadiri, Fotis Nifiatis",
    achievement:
      "Constructing molecular structures through self-organization, using the same forces that assemble molecular machine systems found in nature. Created self-replicating peptide systems.",
    institution: "Scripps Research Institute",
    date: "1998-11",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 1999
  // ============================================================
  {
    year: 1999,
    category: "theory",
    recipient: "William A. Goddard III, Tahir Cagin, Yue Qi",
    achievement:
      "Molecular dynamics simulations and first-principles calculations for nanotechnology applications, including modeling of molecular machines and self-assembled monolayers.",
    institution: "California Institute of Technology",
    date: "1999-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 1999,
    category: "experiment",
    recipient: "Phaedon Avouris, Anita Goel",
    achievement:
      "Experimental advances in carbon nanotube electronics and manipulation of individual molecules using scanning probe techniques.",
    institution: "IBM T.J. Watson Research Center / Harvard University",
    date: "1999-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2000
  // ============================================================
  {
    year: 2000,
    category: "theory",
    recipient: "Uzi Landman",
    achievement:
      "Pioneering computational materials science for nanostructures, including molecular dynamics simulations of nanoscale phenomena such as nanojets, nanotribology, and cluster-surface interactions.",
    institution: "Georgia Institute of Technology",
    date: "2000-11",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2000,
    category: "experiment",
    recipient: "R. Stanley Williams, Philip Kuekes, James Heath, Christopher Love",
    achievement:
      "Demonstrating molecular-scale electronics, including the Teramac computer built with defective components using defect-tolerant architecture, and work on molecular switches and crossbar architectures.",
    institution: "HP Labs / UCLA",
    date: "2000-11",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2001
  // ============================================================
  {
    year: 2001,
    category: "theory",
    recipient: "Mark A. Ratner",
    achievement:
      "Pioneering theoretical work in molecular electronics, including foundational studies of electron transport through single molecules that established the field.",
    institution: "Northwestern University",
    date: "2001-11",
    sourceUrl: "https://foresight.org/molecular_electronics_researchers_awarded_2001_feynman_prizes/",
  },
  {
    year: 2001,
    category: "experiment",
    recipient: "Charles M. Lieber, Jing Kong",
    achievement:
      "Experimental work on carbon nanotube devices and nanowire-based electronics, demonstrating functional electronic circuits at the nanoscale.",
    institution: "Harvard University",
    date: "2001-11",
    sourceUrl: "https://foresight.org/molecular_electronics_researchers_awarded_2001_feynman_prizes/",
  },

  // ============================================================
  // 2002
  // ============================================================
  {
    year: 2002,
    category: "theory",
    recipient: "Don Brenner",
    achievement:
      "Modeling molecular machines made of only a few molecules, developing reactive empirical bond-order potentials for simulating covalent materials at the nanoscale.",
    institution: "North Carolina State University",
    date: "2002-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2002,
    category: "experiment",
    recipient: "Chad Mirkin, Yi Cui",
    achievement:
      "Experimental work in molecular machine systems, particularly dip-pen nanolithography and DNA-based nanostructure assembly for nanoscale patterning.",
    institution: "Northwestern University / Stanford University",
    date: "2002-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2003
  // ============================================================
  {
    year: 2003,
    category: "theory",
    recipient: "Marvin L. Cohen, Steven G. Louie",
    achievement:
      "Contributions to understanding material behavior through models of molecular and electronic structures of new materials that predict properties and interactions.",
    institution: "University of California, Berkeley",
    date: "2003-10",
    sourceUrl: "https://www.nanotech-now.com/Foresight-release-10152003.htm",
  },
  {
    year: 2003,
    category: "experiment",
    recipient: "Carlo Montemagno",
    achievement:
      "Pioneering research integrating single molecule biological motors with nanoscale silicon devices, advancing the field of hybrid bio-nanomachines.",
    institution: "University of California, Los Angeles",
    date: "2003-10",
    sourceUrl: "https://www.nanotech-now.com/Foresight-release-10152003.htm",
  },
  {
    year: 2003,
    category: "student",
    recipient: "Ahmet Yildiz",
    achievement:
      "Studying myosin V molecular motor motion at the single-molecule level, contributing to understanding of biological molecular motors for artificial motor design.",
    institution: "University of Illinois at Urbana-Champaign",
    date: "2003-10",
    sourceUrl: "https://www.nanotech-now.com/Foresight-release-10152003.htm",
  },

  // ============================================================
  // 2004
  // ============================================================
  {
    year: 2004,
    category: "theory",
    recipient: "David Baker, Brian Kuhlman",
    achievement:
      "Developing RosettaDesign, a program with high success rate in designing stable protein structures. Designed the first protein with a naturally unobserved backbone fold that proved extremely stable and matched predictions with atomic-level precision. Baker later won the 2024 Nobel Prize in Chemistry.",
    institution: "University of Washington / University of North Carolina",
    date: "2004-10",
    sourceUrl: "https://legacy.foresight.org/about/2004Feynman.html",
  },
  {
    year: 2004,
    category: "experiment",
    recipient: "Homme Hellinga, Damian Allis",
    achievement:
      "Engineering of atomically precise devices capable of precise manipulation of other molecular structures, using computational design to reengineer natural protein structures into novel functional ones.",
    institution: "Duke University",
    date: "2004-10",
    sourceUrl: "https://legacy.foresight.org/about/2004Feynman.html",
  },

  // ============================================================
  // 2005
  // ============================================================
  {
    year: 2005,
    category: "theory",
    recipient: "Christian Joachim",
    achievement:
      "Developing theoretical tools and establishing principles for the design of a wide variety of single molecular functional nanomachines.",
    institution: "Centre National de la Recherche Scientifique (CNRS), France",
    date: "2005-11",
    sourceUrl: "https://cen.acs.org/articles/84/i2/Feynman-Prizes-Awarded.html",
  },
  {
    year: 2005,
    category: "experiment",
    recipient: "Christian Schafmeister, Christopher Levins",
    achievement:
      "Developing novel technology for synthesizing macromolecules of intermediate sizes with designed shapes and functions, using bis-amino acid monomers to create programmable ladder-shaped structures.",
    institution: "University of Pittsburgh",
    date: "2005-11",
    sourceUrl: "https://cen.acs.org/articles/84/i2/Feynman-Prizes-Awarded.html",
  },

  // ============================================================
  // 2006
  // ============================================================
  {
    year: 2006,
    category: "theory",
    recipient: "Erik Winfree, Paul W.K. Rothemund",
    achievement:
      "Theory and experimental demonstration of DNA computing and DNA origami — folding long single-stranded DNA into arbitrary two-dimensional shapes using short staple strands. The only team to win both Theory and Experiment prizes in the same year.",
    institution: "California Institute of Technology",
    date: "2006-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  // Note: Winfree & Rothemund won BOTH Theory and Experiment in 2006.
  // The Foresight website lists "Berhane Temelso" under Experiment for 2006,
  // but press releases confirm Winfree & Rothemund won both categories.
  // Temelso was likely a student award recipient or Foresight Fellow.

  // ============================================================
  // 2007
  // ============================================================
  {
    year: 2007,
    category: "theory",
    recipient: "David A. Leigh",
    achievement:
      "Designing molecular machines including molecular knots, rotary motors, and mechanically interlocked molecules, advancing the theoretical understanding of controlled molecular motion.",
    institution: "University of Edinburgh",
    date: "2007-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2007,
    category: "experiment",
    recipient: "J. Fraser Stoddart",
    achievement:
      "Experimental work on molecular switches, motors, and mechanically interlocked molecules (rotaxanes and catenanes). Later won the 2016 Nobel Prize in Chemistry for the design and synthesis of molecular machines.",
    institution: "UCLA (later Northwestern University)",
    date: "2007-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2007,
    category: "student",
    recipient: "Fung Suong Ou",
    achievement:
      "Notable student work in nanotechnology.",
    institution: "University of California",
    date: "2007-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2008
  // ============================================================
  {
    year: 2008,
    category: "theory",
    recipient: "George C. Schatz",
    achievement:
      "Theoretical contributions to nanofabrication and nanoscale sensing, including computational studies of plasmonic nanostructures and their optical properties.",
    institution: "Northwestern University",
    date: "2008-12",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2008,
    category: "experiment",
    recipient: "James M. Tour",
    achievement:
      "Synthesis of nanocars — molecule-sized vehicles with buckyball (C60) wheels that demonstrated the possibility of building working machines at the nanoscale.",
    institution: "Rice University",
    date: "2008-12",
    sourceUrl: "https://news2.rice.edu/2008/12/17/rices-james-tour-wins-feynman-prize/",
  },

  // ============================================================
  // 2009
  // ============================================================
  {
    year: 2009,
    category: "theory",
    recipient: "Robert A. Freitas Jr.",
    achievement:
      "Pioneering theoretical work in mechanosynthesis, including molecular tool design and analysis, plus systems design of molecular machines and medical nanodevices (nanomedicine).",
    institution: "Institute for Molecular Manufacturing (IMM)",
    date: "2009-10",
    sourceUrl: "https://phys.org/news/2009-10-foresight-feynman-prize-winners.html",
  },
  {
    year: 2009,
    category: "experiment",
    recipient: "Yoshiaki Sugimoto, Masayuki Abe, Oscar Custance",
    achievement:
      "Demonstrating mechanosynthesis through atomic resolution dynamic force microscopy — manipulating single atoms on semiconductor surfaces at room temperature.",
    institution: "Osaka University / National Institute for Materials Science (NIMS), Japan",
    date: "2009-10",
    sourceUrl: "https://phys.org/news/2009-10-foresight-feynman-prize-winners.html",
  },

  // ============================================================
  // 2010
  // ============================================================
  {
    year: 2010,
    category: "theory",
    recipient: "Gustavo E. Scuseria",
    achievement:
      "Developing computational tools for carbon research and nanoscale materials, with work incorporated into widely used quantum chemistry software packages in thousands of laboratories worldwide.",
    institution: "Rice University",
    date: "2010-12",
    sourceUrl: "http://news.rice.edu/2011/01/20/chemistrys-scuseria-wins-feynman-prize/",
  },
  {
    year: 2010,
    category: "experiment",
    recipient: "Masakazu Aono",
    achievement:
      "Pioneering work in manipulation of individual atoms, development of the multiprobe STM and AFM, and invention of the atomic switch for nanoscale information processing.",
    institution: "National Institute for Materials Science (NIMS), Japan",
    date: "2010-12",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2011
  // ============================================================
  {
    year: 2011,
    category: "theory",
    recipient: "Raymond Astumian",
    achievement:
      "Theoretical work on molecular motors and nanoscale machines, including the theory of Brownian motors and how thermal fluctuations can be harnessed to do directed work at the molecular level.",
    institution: "University of Maine",
    date: "2011-10",
    sourceUrl: "https://foresight.org/foresight-prizes/2011-foresight-institute-feynman-prize/",
  },
  {
    year: 2011,
    category: "experiment",
    recipient: "Leonhard Grill",
    achievement:
      "Experimental advances in single-molecule chemistry on surfaces using scanning probe microscopy, including triggering and controlling chemical reactions at the single-molecule level.",
    institution: "Fritz Haber Institute, Berlin",
    date: "2011-10",
    sourceUrl: "https://foresight.org/foresight-prizes/2011-foresight-institute-feynman-prize/",
  },

  // ============================================================
  // 2012
  // ============================================================
  {
    year: 2012,
    category: "theory",
    recipient: "David Soloveichik",
    achievement:
      "General theory of DNA strand displacement cascades, showing that systems of DNA molecules can be designed with arbitrary dynamic behavior and are Turing-complete, proving DNA molecules can compute any function.",
    institution: "University of California, San Francisco",
    date: "2012-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2012,
    category: "experiment",
    recipient: "Gerhard Meyer, Leo Gross, Jascha Repp",
    achievement:
      "Advancing scanning probe microscopy — first to produce images of molecular orbitals and charge distributions detailed enough to identify the structure of individual molecules.",
    institution: "IBM Research Zurich / University of Regensburg",
    date: "2012-10",
    sourceUrl: "https://www.ibm.com/blogs/research/2013/01/ibm-scientists-honored-with-feynman-prize/",
  },
  {
    year: 2012,
    category: "student",
    recipient: "David Walker",
    achievement:
      "Notable student work in nanotechnology.",
    institution: "",
    date: "2012-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2013
  // ============================================================
  {
    year: 2013,
    category: "theory",
    recipient: "David N. Beratan",
    achievement:
      "Theoretical contributions to understanding electron transfer in molecules and biological systems, advancing the design of molecular electronic devices.",
    institution: "Duke University",
    date: "2013-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2013,
    category: "experiment",
    recipient: "Alexander K. Zettl",
    achievement:
      "Fabrication of nanoscale electromechanical systems (NEMS) spanning multiple decades, including carbon nanotube-based bearings, actuators, and sensors with cutting-edge nanoscale engineering.",
    institution: "University of California, Berkeley",
    date: "2013-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
  {
    year: 2013,
    category: "student",
    recipient: "Jonathan C. Barnes",
    achievement:
      "Notable student work in molecular nanotechnology.",
    institution: "Northwestern University",
    date: "2013-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2014
  // ============================================================
  {
    year: 2014,
    category: "theory",
    recipient: "Amanda S. Barnard",
    achievement:
      "Theoretical work on diamond nanoparticles, including computational modeling of nanoparticle structure, stability, and properties. First woman and first Southern Hemisphere researcher to win the Feynman Prize.",
    institution: "CSIRO (Commonwealth Scientific and Industrial Research Organisation), Australia",
    date: "2014-11",
    sourceUrl: "https://foresight.org/foresight-institute-awards-feynman-prizes-in-nanotechnology-to-amanda-s-barnard-joseph-w-lyding",
  },
  {
    year: 2014,
    category: "experiment",
    recipient: "Joseph W. Lyding",
    achievement:
      "Creating Hydrogen Resist Lithography technology and contributions to the development of Scanning Tunneling Microscopy for nanoscale patterning and fabrication.",
    institution: "University of Illinois at Urbana-Champaign",
    date: "2014-11",
    sourceUrl: "https://ece.illinois.edu/newsroom/3394",
  },

  // ============================================================
  // 2015
  // ============================================================
  {
    year: 2015,
    category: "theory",
    recipient: "Markus J. Buehler",
    achievement:
      "Influential research enabling new multiscale models in hierarchical systems, making nanotechnology scalable for large-scale materials applications through bottom-up multiscale computational methods.",
    institution: "Massachusetts Institute of Technology (MIT)",
    date: "2015-11",
    sourceUrl: "https://news.mit.edu/2016/markus-buehler-awarded-foresight-institute-feynman-prize-0524",
  },
  {
    year: 2015,
    category: "experiment",
    recipient: "Michelle Y. Simmons",
    achievement:
      "Creating the field of atomic-electronics, demonstrating fabrication of atomic-scale devices in silicon using scanning tunneling microscope precision. Developed the world's first single atom transistor and thinnest conducting doped wires in silicon.",
    institution: "University of New South Wales (UNSW), Australia",
    date: "2015-11",
    sourceUrl: "https://newsroom.unsw.edu.au/news/science-tech/top-international-award-quantum-computing-chief",
  },
  {
    year: 2015,
    category: "student",
    recipient: "Chuyang Cheng",
    achievement:
      "Originating the idea of using inversion of interactions between viologen and cyclobis(paraquat-p-phenylene) under different redox conditions to make artificial molecular pumps.",
    institution: "Northwestern University",
    date: "2015-11",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2016
  // ============================================================
  {
    year: 2016,
    category: "theory",
    recipient: "Bartosz A. Grzybowski",
    achievement:
      "Pioneering research in computer-assisted organic synthesis and self-assembly, developing Chematica/Synthia — an AI system for planning chemical synthesis routes.",
    institution: "UNIST (Ulsan National Institute of Science and Technology), South Korea / IBS",
    date: "2016-10",
    sourceUrl: "https://www.eurekalert.org/pub_releases/2016-10/unio-upr100716.php",
  },
  {
    year: 2016,
    category: "experiment",
    recipient: "Franz J. Giessibl, Conrad Pfeiffer",
    achievement:
      "Pioneering major advancements in scanning probe microscopy, including the first achievement of atomic resolution by frequency modulation atomic force microscopy for imaging and manipulating individual atoms.",
    institution: "University of Regensburg, Germany",
    date: "2016-10",
    sourceUrl: "https://www.chemeurope.com/en/news/160110/feynman-prizes-in-nanotechnology-awarded-to-bartosz-a-grzybowski-and-franz-j-giessibl.html",
  },

  // ============================================================
  // 2017
  // ============================================================
  {
    year: 2017,
    category: "theory",
    recipient: "Giovanni Zocchi",
    achievement:
      "Inventing nano-rheology — a nanotechnology measuring method that can measure enzyme deformations smaller than an atom, providing unprecedented insight into molecular machine dynamics.",
    institution: "University of California, Los Angeles (UCLA)",
    date: "2017-10",
    sourceUrl: "https://newsroom.ucla.edu/dept/faculty/physicist-wins-2017-feynman-theory-prize",
  },
  {
    year: 2017,
    category: "experiment",
    recipient: "William Shih",
    achievement:
      "Advancing biomolecular nanotechnology, including development of DNA origami techniques for creating complex three-dimensional nanostructures with programmable shapes and functions.",
    institution: "Harvard University",
    date: "2017-10",
    sourceUrl: "https://www.prweb.com/releases/foresight_institute_awards_feynman_prizes_in_nanotechnology_to_zocchi_shih_distinguished_student_prize_to_qian_/prweb14711086.htm",
  },
  {
    year: 2017,
    category: "student",
    recipient: "Hai Qian",
    achievement:
      "Notable student work in nanotechnology.",
    institution: "",
    date: "2017-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2018
  // ============================================================
  {
    year: 2018,
    category: "theory",
    recipient: "Anatole von Lilienfeld",
    achievement:
      "Applying machine learning to quantum chemistry, developing methods for rapid prediction of quantum properties of molecules and materials.",
    institution: "University of Basel, Switzerland",
    date: "2018-05",
    sourceUrl: "https://nccr-marvel.ch/news/awards/2018-05-feynman-theory-prize-to-anatole-von-lilienfeld",
  },
  {
    year: 2018,
    category: "experiment",
    recipient: "Andreas Heinrich, Christopher Lutz",
    achievement:
      "Seminal contributions in manipulating atoms and small molecules on surfaces and employing them for data storage and computation, including building the world's smallest magnetic memory bit.",
    institution: "IBS Center for Quantum Nanoscience (Seoul) / IBM Research",
    date: "2018-05",
    sourceUrl: "https://www.ibs.re.kr/cop/bbs/BBSMSTR_000000000611/selectBoardArticle.do?nttId=15681",
  },
  {
    year: 2018,
    category: "student",
    recipient: "Qi Li",
    achievement:
      "Notable student work in nanotechnology.",
    institution: "",
    date: "2018-05",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2019
  // ============================================================
  {
    year: 2019,
    category: "theory",
    recipient: "Giulia Galli",
    achievement:
      "Theoretical and computational work on the electronic structure of nanomaterials, water, and aqueous solutions, developing first-principles methods to predict material properties for energy and sustainability applications.",
    institution: "University of Chicago / Argonne National Laboratory",
    date: "2019-10",
    sourceUrl: "https://pme.uchicago.edu/news/giulia-galli-wins-2019-feynman-theory-prize",
  },
  {
    year: 2019,
    category: "experiment",
    recipient: "Lulu Qian",
    achievement:
      "Programming molecular behaviors using DNA-based neural networks and strand displacement cascades, creating molecular circuits that can classify complex patterns.",
    institution: "California Institute of Technology",
    date: "2019-10",
    sourceUrl: "https://www.prweb.com/releases/foresight_institute_awards_2019_feynman_prizes_in_nanotechnology_to_qian_galli_awards_presented_by_nobelist_sir_fraser_stoddart/prweb16607838.htm",
  },
  {
    year: 2019,
    category: "student",
    recipient: "Yuxing Yao",
    achievement:
      "Work in biomineralization and biomimetics, developing novel approaches to nanomaterial synthesis inspired by biological processes.",
    institution: "Harvard University / California Institute of Technology",
    date: "2019-10",
    sourceUrl: "https://www.prweb.com/releases/foresight_institute_awards_2019_distinguished_student_prize_to_yuxing_yao_of_caltech_and_harvard/prweb16607845.htm",
  },

  // ============================================================
  // 2020
  // ============================================================
  {
    year: 2020,
    category: "theory",
    recipient: "Massimiliano Di Ventra",
    achievement:
      "Major theoretical contributions including quantum transport studies in nanoscale systems, novel computational techniques (memcomputing), and quantum sequencing approaches for DNA base detection in nanochannels.",
    institution: "University of California, San Diego",
    date: "2020-12",
    sourceUrl: "https://www.prweb.com/releases/foresight_institute_awards_2020_feynman_prizes_in_nanotechnology_to_yan_di_ventra/prweb17567779.htm",
  },
  {
    year: 2020,
    category: "experiment",
    recipient: "Hao Yan",
    achievement:
      "Pioneering work in structural DNA nanotechnology, designing novel DNA nanostructures and creating DNA-directed enzyme cascades and nanoparticle arrays using nucleic acids as programmable molecular building blocks.",
    institution: "Arizona State University",
    date: "2020-12",
    sourceUrl: "https://news.asu.edu/20201215-asu-professor-receives-2020-foresight-institute-feynman-prize",
  },
  {
    year: 2020,
    category: "student",
    recipient: "Liang Feng",
    achievement:
      "Work in metal-organic frameworks and porous materials with applications in nanotechnology.",
    institution: "Texas A&M University / Northwestern University",
    date: "2020-12",
    sourceUrl: "https://www.prweb.com/releases/Foresight_Institute_Awards_2020_Distinguished_Student_Prize_to_Liang_Feng_of_Northwestern_University/prweb17588337.htm",
  },

  // ============================================================
  // 2021
  // ============================================================
  {
    year: 2021,
    category: "theory",
    recipient: "Kendall N. Houk",
    achievement:
      "Theoretical and computational organic chemistry, including computational studies of reaction mechanisms and molecular dynamics that advance understanding of molecular machine operation.",
    institution: "University of California, Los Angeles (UCLA)",
    date: "2021-10",
    sourceUrl: "https://www.chemistry.ucla.edu/news/2021-foresight-institute-feynman-prize-theory/",
  },
  {
    year: 2021,
    category: "experiment",
    recipient: "Anne-Sophie Duwez",
    achievement:
      "Developing tools to interface synthetic functional molecules with AFM for studying molecular machine operation one molecule at a time. First to apply AFM-based single-molecule force spectroscopy to a small molecule just a few nanometers long.",
    institution: "University of Liege, Belgium",
    date: "2021-10",
    sourceUrl: "https://www.sciences.uliege.be/cms/c_8140757/en/anne-sophie-duwez-winner-of-the-feynman-prize-in-nanotechnology",
  },
  {
    year: 2021,
    category: "student",
    recipient: "Yuanning Feng",
    achievement:
      "Developing several artificial molecular pumps during graduate studies in the Stoddart Group at Northwestern University.",
    institution: "Northwestern University",
    date: "2021-10",
    sourceUrl: "https://stoddart.northwestern.edu/2021/10/yuanning-feng-selected-for-the-2021-foresight-institute-distinguished-student-award/",
  },

  // ============================================================
  // 2022
  // ============================================================
  {
    year: 2022,
    category: "theory",
    recipient: "James R. Chelikowsky",
    achievement:
      "Computational contributions advancing Feynman's goal of visualizing and manipulating atoms, including algorithms for solving electronic structure problems in large systems containing over 200,000 atoms.",
    institution: "University of Texas at Austin (Oden Institute)",
    date: "2022-10",
    sourceUrl: "https://oden.utexas.edu/news-and-events/news/James-Chelikowsky-Wins-Feynman-Prize/",
  },
  {
    year: 2022,
    category: "experiment",
    recipient: "Sergei V. Kalinin",
    achievement:
      "AI-driven scanning transmission electron microscopy (STEM) enabling analysis and fabrication of materials one atom at a time, combining machine learning with electron beam-induced reactions for direct atomic assembly.",
    institution: "University of Tennessee / Oak Ridge National Laboratory",
    date: "2022-10",
    sourceUrl: "https://tickle.utk.edu/mse/foresight-institute-honors-kalinin-with-prestigious-feynman-prize/",
  },
  {
    year: 2022,
    category: "student",
    recipient: "Emanuele Penocchio",
    achievement:
      "Notable student work in molecular nanotechnology.",
    institution: "Northwestern University",
    date: "2022-10",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },

  // ============================================================
  // 2023
  // ============================================================
  {
    year: 2023,
    category: "theory",
    recipient: "Alexandre Tkatchenko",
    achievement:
      "Advancing quantum-mechanical methods for realistic molecular systems, integrating quantum mechanics, statistical mechanics, and machine learning to study complex molecules and materials.",
    institution: "University of Luxembourg",
    date: "2023-12",
    sourceUrl: "https://www.uni.lu/fstm-en/news/prof-alexandre-tkatchenko-awarded-the-2023-foresight-feynman-prize-in-nanotechnology/",
  },
  {
    year: 2023,
    category: "experiment",
    recipient: "James J. Collins",
    achievement:
      "Pioneering synthetic gene circuits with practical applications in diagnostics and therapeutics, including a genetic toggle switch enabling programmable diagnostics and on-demand production of vaccine antigens and antibiotics.",
    institution: "Massachusetts Institute of Technology (MIT)",
    date: "2023-12",
    sourceUrl: "https://www.prweb.com/releases/foresight-institute-announces-2023-feynman-prize-winners-301970124.html",
  },
  {
    year: 2023,
    category: "student",
    recipient: "Qiancheng Xiong",
    achievement:
      "Developing programmable DNA nanodevices using CRISPR-Cas12a technology to refine DNA-origami structures, including hybrid toxin-DNA nanopores for creating synthetic compartments.",
    institution: "Yale University",
    date: "2023-12",
    sourceUrl: "https://www.prweb.com/releases/foresight-institute-announces-2023-feynman-prize-winners-301970124.html",
  },

  // ============================================================
  // 2024
  // ============================================================
  {
    year: 2024,
    category: "theory",
    recipient: "Klaus-Robert Muller",
    achievement:
      "Contributing to mathematical foundations of machine learning for quantum chemistry, significantly accelerating prediction of quantum properties through intelligent use of machine learning models.",
    institution: "TU Berlin / BIFOLD",
    date: "2024-12",
    sourceUrl: "https://www.bifold.berlin/news-events/news/view/news-detail/feynman-prize-for-prof-dr-klaus-robert-mueller",
  },
  {
    year: 2024,
    category: "experiment",
    recipient: "Saw Wai Hla",
    achievement:
      "Developing complex molecular machines and motors, atomically precise rotation of rare-earth complexes, and analysis of single atoms using X-rays, with applications in microelectronics, quantum computing, and medical devices.",
    institution: "Ohio University / Argonne National Laboratory",
    date: "2024-12",
    sourceUrl: "https://www.ohio.edu/news/2024/12/saw-wai-hla-receives-feynman-prize-excellence-nanotechnology-experimentation",
  },
  {
    year: 2024,
    category: "student",
    recipient: "Gabriella Gagliano",
    achievement:
      "Notable student work in nanotechnology.",
    institution: "",
    date: "2024-12",
    sourceUrl: "https://foresight.org/prizes/feynman-prizes/",
  },
];

// ---------------------------------------------------------------------------
// Grant source
// ---------------------------------------------------------------------------

function feynmanPrizeAmount(category: string): number {
  switch (category) {
    case "theory":
    case "experiment":
      return 5_000;
    case "student":
      return 1_000;
    default:
      return 5_000;
  }
}

function feynmanProgramId(category: string): string {
  switch (category) {
    case "theory":
      return FEYNMAN_THEORY_PROGRAM_ID;
    case "experiment":
      return FEYNMAN_EXPERIMENT_PROGRAM_ID;
    case "student":
      return FEYNMAN_STUDENT_PROGRAM_ID;
    default:
      return FEYNMAN_THEORY_PROGRAM_ID;
  }
}

function feynmanPrizeName(award: FeynmanAward): string {
  const categoryLabels: Record<string, string> = {
    theory: "Theory",
    experiment: "Experiment",
    student: "Distinguished Student Award",
  };
  return `Feynman Prize ${award.year} — ${categoryLabels[award.category] ?? award.category}`;
}

function feynmanFocusArea(category: string): string {
  switch (category) {
    case "theory":
      return "Nanotechnology (Theory)";
    case "experiment":
      return "Nanotechnology (Experiment)";
    case "student":
      return "Nanotechnology (Student)";
    default:
      return "Nanotechnology";
  }
}

export const source: GrantSource = {
  id: "foresight-prizes",
  name: "Foresight Institute Prizes",
  sourceUrl: "https://foresight.org/prizes/feynman-prizes/",

  ensureData() {
    // No external data to download — awards are curated inline
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const grants: RawGrant[] = [];

    // Norm Hardy Prize awards
    for (const award of NORM_HARDY_AWARDS) {
      const granteeId = matchGrantee(award.recipient, matcher);

      grants.push({
        source: "foresight-prizes",
        funderId: FUNDER_IDS.FORESIGHT_INSTITUTE,
        granteeName: award.recipient,
        granteeId,
        name: `Norm Hardy Prize ${award.year}`,
        amount: 10_000,
        currency: "USD",
        date: award.date,
        focusArea: "Usable security",
        description: `${award.achievement} Institution(s): ${award.institution}.`,
        sourceUrl: award.sourceUrl,
        programId: NORM_HARDY_PROGRAM_ID,
      });
    }

    // Feynman Prize awards
    for (const award of FEYNMAN_AWARDS) {
      const granteeId = matchGrantee(award.recipient, matcher);

      grants.push({
        source: "foresight-prizes",
        funderId: FUNDER_IDS.FORESIGHT_INSTITUTE,
        granteeName: award.recipient,
        granteeId,
        name: feynmanPrizeName(award),
        amount: feynmanPrizeAmount(award.category),
        currency: "USD",
        date: award.date,
        focusArea: feynmanFocusArea(award.category),
        description: `${award.achievement} Institution(s): ${award.institution}.`,
        sourceUrl: award.sourceUrl,
        programId: feynmanProgramId(award.category),
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    const normHardy = grants.filter((g) => g.name.startsWith("Norm Hardy"));
    const feynman = grants.filter((g) => g.name.startsWith("Feynman"));

    console.log(`\nNorm Hardy Prize: ${normHardy.length} awards`);
    for (const g of normHardy) {
      const matched = g.granteeId ? " [matched]" : "";
      console.log(`  ${g.date}: ${g.granteeName}${matched}`);
    }

    console.log(`\nFeynman Prize: ${feynman.length} awards`);
    const byYear = new Map<string, RawGrant[]>();
    for (const g of feynman) {
      const year = g.date?.substring(0, 4) ?? "????";
      const existing = byYear.get(year) || [];
      existing.push(g);
      byYear.set(year, existing);
    }
    for (const [year, yearGrants] of [...byYear].sort()) {
      for (const g of yearGrants) {
        const matched = g.granteeId ? " [matched]" : "";
        const category = g.focusArea?.replace("Nanotechnology (", "").replace(")", "") ?? "";
        console.log(`  ${year} ${category}: ${g.granteeName}${matched}`);
      }
    }
  },
};
