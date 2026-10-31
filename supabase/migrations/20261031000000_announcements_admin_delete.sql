-- Admins couldn't delete announcements: there was no DELETE policy, so the
-- client's delete matched 0 rows and the banner stayed. Also drops the old
-- wide-open "Admin insert" / "Admin update" (true) policies that were still live.
DROP POLICY IF EXISTS "Admin insert" ON public.announcements;
DROP POLICY IF EXISTS "Admin update" ON public.announcements;
DROP POLICY IF EXISTS announcements_delete ON public.announcements;
CREATE POLICY announcements_delete ON public.announcements FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = true));
