import { queryOptions } from "@tanstack/react-query";
import { BlogList, BlogPostList } from "@ai-news/contracts";
import { request } from "../lib/http.ts";

export const blogsQueryOptions = queryOptions({
  queryKey: ["blogs"],
  queryFn: async () => BlogList.parse(await request("/api/blogs")),
});

export function blogPostsQueryOptions({ blog, page }: { blog?: string; page?: number }) {
  const params = new URLSearchParams();
  if (blog) params.set("blog", blog);
  params.set("page", String(page ?? 1));

  return queryOptions({
    queryKey: ["blog-posts", blog ?? null, page ?? 1],
    queryFn: async () => BlogPostList.parse(await request(`/api/blog-posts?${params.toString()}`)),
  });
}
