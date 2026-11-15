# RAFT Front Desk — First Four Screens

A four-screen front end for the Richmond Area Family Therapy (RAFT) database in Supabase.

**Live site:** https://ziegenf.github.io/raft-frontdesk/

Screens: **Home**, **Client lookup**, **Dashboard**, and **Add / edit** (new appointment, edit appointment, edit client,
notes & assignments). Sign-in comes first, and every screen has a sign-out link. Admin, Scheduler and Counselor logins
each see only what their database role allows, and the Supabase grants enforce it.

The site is plain HTML, CSS and JavaScript with supabase-js loaded from a CDN, so there is no build step. GitHub Pages
serves it straight from the `main` branch.

## Which AI tool I used
Claude Code (Anthropic's coding agent in the terminal).

## My first prompt
I used the assignment brief and gave Claude Code the RAFT 3 Implementation Solution script for the table definitions.
My professor allowed us to use AI however we wanted, so I also had Claude Code do the Supabase setup through the
Supabase Management API: run the solution script and the staff-roles grants, add `raft` to the exposed schemas, create
the three users with their `staff_role`, and turn on the access-token hook. It also created the GitHub repo and turned
on GitHub Pages. No table, column or constraint was added, changed or removed.

## What the AI got wrong or left out, and how it was fixed
- **The grants script did not match the RAFT 3 tables.** It grants `employee.employeeid`, but in the RAFT 3 solution
  the employee key is `employee.personid` (Employee is a subtype of Person). We changed only that column name in the
  two `grant select (...) on raft.employee` lines. Everything else in the script is unchanged.
- **Adding a new client is not possible without changing the database.** The schema has deferred triggers that require
  every `person` row to also be a client, counselor, employee or family member *in the same transaction*. Each website
  request is its own transaction, so a person row and a client row cannot be inserted together without adding a
  database function, which the assignment forbids. So the Add/Edit screen **adds new appointments** and **edits existing
  clients and appointments**, and it explains why new clients cannot be added there.
- **Test data.** While testing the forms we created test appointments, which cannot be deleted because nobody has
  delete rights. We restored Holly's clean sample data by re-running the solution script and the grants.
- **Small issues found in testing:** the first versions of the automated browser tests clicked the hidden sign-in
  button and filled forms before the screen finished loading. These were problems in the tests, not the site, and were
  fixed in the test scripts. The tests also confirmed that the database's room-overlap trigger rejects double-booked
  rooms and that the site shows its message ("Room 1 is already booked during that time").

## The change I made (Step 7) and why
I added a **Client referrals** section to the dashboard. It shows what share of clients were referred by another client
and who the top referrers are, calculated from `client.referredby`. Word of mouth is how most RAFT clients find the
practice ("Family" is the top answer for how they found out), so the front desk can see which clients bring others in.
The change was committed, pushed, and checked on the live URL.
