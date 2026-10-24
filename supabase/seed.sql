-- Starter groups so the app isn't empty on day one. Rename or delete these to match your church.
-- To make someone a group admin (so they can add events), run:
--   update group_members set role = 'admin'
--   where group_id = (select id from groups where name = 'Youth Group')
--     and user_id = (select id from profiles where username = 'their_username');

insert into public.groups (name, about, meets, art) values
  ('Youth Group', 'High schoolers: worship, small groups and a lot of pizza.', 'Wednesdays 7 PM', 'sea'),
  ('Men''s Bible Study', 'Working through one book of the Bible together, a chapter a week.', 'Saturdays 8 AM', 'hills'),
  ('Women''s Bible Study', 'Study, prayer and friendship. Bring a journal.', 'Tuesdays 6:30 PM', 'bloom'),
  ('Worship Team', 'Musicians, singers and tech crew who lead Sunday services.', 'Thursdays 7 PM', 'night'),
  ('Young Adults', 'Ages 18 to 30. Dinner, a short teaching and good conversation.', 'Sundays 6 PM', 'dawn');
